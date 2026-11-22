"""Download an update from its original host using validated HTTP byte ranges."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
import hashlib
import http.client
import re
import threading
import time
import urllib.error
import urllib.request

BUFFER = 256 * 1024
PARALLEL_MIN = 8 * 1024 * 1024
PACKAGE_LIMIT = 512 * 1024 * 1024
LANES = 3
SAMPLE_TIME = 0.55
SLOW_RATE = 3 * 1024 * 1024
RANGE_REPLY = re.compile(r"bytes (\d+)-(\d+)/(\d+)")
SHA = re.compile(r"[0-9a-f]{64}")


class DownloadError(RuntimeError):
    pass


class DownloadCancelled(DownloadError):
    pass


def content_range(response):
    match = RANGE_REPLY.fullmatch(response.headers.get("Content-Range", ""))
    if not match:
        raise DownloadError("更新服务器返回了无效的分段范围")
    return tuple(int(value) for value in match.groups())


def identity_response(response):
    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
        raise DownloadError("更新服务器返回了非原始文件内容")


def expected_length(headers, expected):
    try:
        total = int(headers.get("Content-Length") or expected or 0)
    except ValueError as exc:
        raise DownloadError("更新服务器返回了无效的文件大小") from exc
    if not 0 <= total <= PACKAGE_LIMIT or (expected and total != expected):
        raise DownloadError("更新包大小与发布记录不符")
    return total


def download_package(url, target, expected, digest, agent, cancelled, progress):
    """Return received size. progress(bytes,total,connections) uses unique bytes, not retries."""
    if not 0 <= expected <= PACKAGE_LIMIT:
        raise DownloadError("发布记录中的更新包大小无效")
    if digest and not SHA.fullmatch(digest):
        raise DownloadError("更新包的 SHA-256 信息无效")
    stop = threading.Event()
    progress_lock = threading.Lock()
    got = 0

    def check_cancel():
        if cancelled.is_set() or stop.is_set():
            raise DownloadCancelled("已取消")

    def open_url(resource, range_header=None, etag=None):
        check_cancel()
        headers = {"User-Agent": agent, "Accept-Encoding": "identity"}
        if range_header:
            headers["Range"] = range_header
        if etag:
            headers["If-Match"] = etag
        return urllib.request.urlopen(urllib.request.Request(resource, headers=headers), timeout=12)

    def report(count, total, connections):
        nonlocal got
        with progress_lock:
            got += count
            progress(got, total, connections)

    def segmented(first_response, total, etag):
        report(0, total, LANES)
        prefix = got
        resource = first_response.geturl()
        with target.open("r+b") as output:
            output.truncate(total)

        def range_writer(start, end, initial):
            cursor = start
            with target.open("r+b") as output:
                output.seek(start)
                for attempt in range(3):
                    check_cancel()
                    try:
                        reuse = initial is not None and attempt == 0
                        response = initial if reuse else open_url(resource, f"bytes={cursor}-{end}", etag)
                        with closing(response):
                            if not reuse:
                                if response.status != 206 or content_range(response) != (cursor, end, total):
                                    raise DownloadError("更新服务器未确认指定分段，已停止下载")
                                identity_response(response)
                                if etag and response.headers.get("ETag") != etag:
                                    raise DownloadError("下载中的更新包已变化，请重新检查更新")
                            while cursor <= end:
                                check_cancel()
                                block = response.read(min(BUFFER, end - cursor + 1))
                                if not block:
                                    raise http.client.IncompleteRead(b"")
                                output.write(block)
                                cursor += len(block)
                                report(len(block), total, LANES)
                        return
                    except urllib.error.HTTPError as exc:
                        code = exc.code
                        exc.close()
                        if code not in (500, 502, 503, 504):
                            raise DownloadError(f"下载分段失败（HTTP {code}）") from None
                    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
                        pass
                    if attempt == 2:
                        raise DownloadError("连接多次中断，未能下载完整更新包")
                    if cancelled.wait(0.3 * (attempt + 1)):
                        check_cancel()

        with ThreadPoolExecutor(max_workers=LANES, thread_name_prefix="update-download") as pool:
            jobs = [pool.submit(range_writer, prefix if i == 0 else i * total // LANES,
                                (i + 1) * total // LANES - 1, first_response if i == 0 else None)
                    for i in range(LANES)]
            try:
                for future in as_completed(jobs):
                    future.result()
            except BaseException:
                stop.set()
                raise
        if got != total:
            raise DownloadError("更新分段没有全部收到")

    def initial_response():
        for attempt in range(2):
            try:
                return open_url(url)
            except urllib.error.HTTPError as exc:
                if attempt or exc.code not in (500, 502, 503, 504):
                    exc.close()
                    raise DownloadError(f"连接更新源失败（HTTP {exc.code}）") from None
                exc.close()
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt:
                    raise
            if cancelled.wait(.25):
                check_cancel()

    check_cancel()
    # Start transferring immediately. Don't add connections on a link that's already fast.
    with closing(initial_response()) as response:
        if response.status != 200:
            raise DownloadError("更新服务器没有返回完整文件")
        identity_response(response)
        total = expected_length(response.headers, expected)
        tag = response.headers.get("ETag", "")
        etag = tag if tag.startswith('"') and tag.endswith('"') else None
        can_split = (total >= PARALLEL_MIN and (etag or digest)
                     and response.headers.get("Accept-Ranges", "").lower() == "bytes")
        accelerating = False
        report(0, total, 1)
        started = time.monotonic()
        with target.open("wb") as output:
            while True:
                check_cancel()
                block = response.read(BUFFER)
                if not block:
                    break
                if got + len(block) > PACKAGE_LIMIT or total and got + len(block) > total:
                    raise DownloadError("收到的更新包超出发布记录")
                output.write(block)
                report(len(block), total, 1)
                elapsed = time.monotonic() - started
                if can_split and got < total // LANES and elapsed >= SAMPLE_TIME and got / elapsed < SLOW_RATE:
                    accelerating = True
                    break
        if accelerating:
            segmented(response, total, etag)
        if total and total != got:
            raise DownloadError("更新包没有完整下载")

    check_cancel()
    if got < 65536:
        raise DownloadError("下载内容太小，可能不是 Windows 更新包")
    with target.open("rb") as downloaded:
        if downloaded.read(2) != b"MZ":
            raise DownloadError("下载到的不是 Windows 可执行文件")
        if digest:
            downloaded.seek(0)
            sha = hashlib.sha256()
            for block in iter(lambda: downloaded.read(BUFFER), b""):
                check_cancel()
                sha.update(block)
            if sha.hexdigest() != digest:
                raise DownloadError("更新包 SHA-256 校验失败，未应用更新")
    check_cancel()
    return got
