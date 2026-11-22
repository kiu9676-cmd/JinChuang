"""Disk-backed, offset-checked receiver for direct single-file transfers."""
import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path

MAX_CHUNK = 4 * 1024 * 1024  # browser intake + old peers
NETWORK_CHUNK = 32 * 1024 * 1024
BUFFER = 256 * 1024
ID = re.compile(r"[A-Za-z0-9_-]{1,96}")
DIGEST = re.compile(r"[a-f0-9]{64}")


class TransferError(Exception):
    def __init__(self, message, status=400, **detail):
        super().__init__(message)
        self.status = status
        self.detail = detail


def digest_file(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(MAX_CHUNK), b""):
            result.update(block)
    return result.hexdigest()


def file_stamp(path):
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def write_record(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(record, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_record(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


class ChunkStore:
    def __init__(self, data, destination, available_name):
        self.directory = data / "transfers-in"
        self.destination = destination
        self.available_name = available_name
        self.locks = [threading.RLock() for _ in range(32)]
        self.commit_lock = threading.Lock()
        self.digest_lock = threading.Lock()
        self.stream_digests = OrderedDict()

    @staticmethod
    def key(source, tid):
        if not (isinstance(source, str) and ID.fullmatch(source)
                and isinstance(tid, str) and ID.fullmatch(tid)):
            raise TransferError("传输编号无效")
        return hashlib.sha256((source + ":" + tid).encode()).hexdigest()

    def _path(self, key):
        return self.directory / (key + ".json")

    def _lock(self, key):
        return self.locks[int(key[:2], 16) % len(self.locks)]

    def _record(self, key):
        record = read_record(self._path(key))
        if record is None:
            raise TransferError("接收端没有这项任务，请重新查询进度", 404)
        return record

    def _offset(self, record):
        if record.get("complete"):
            return record["size"]
        if record.get("canceled"):
            return 0
        part = Path(record["part"])
        if part.is_file():
            return min(record.get("offset", 0), part.stat().st_size)
        return record["size"] if record.get("target") and Path(record["target"]).is_file() else 0

    def _view(self, record, key):
        return dict(ok=True, offset=self._offset(record), complete=bool(record.get("complete")),
                    path=("received/" + key + "/" + Path(record["target"]).name) if record.get("complete") else "",
                    approval=record.get("approval", ""))

    def status(self, meta, observe=None, *, prepare=False):
        key = self.key(meta.get("from"), meta.get("id"))
        size, checksum = meta.get("size"), meta.get("sha256")
        valid_size = type(size) is int and 0 <= size < 2**53
        valid_hash = (meta.get("sendMode") == "online" and checksum is None) if prepare else (
            isinstance(checksum, str) and DIGEST.fullmatch(checksum))
        if not valid_size or not valid_hash:
            raise TransferError("文件大小或校验值无效")
        with self._lock(key):
            record = read_record(self._path(key))
            fresh = record is None
            if fresh:
                part = self.destination().resolve() / ".jinchuan-partials" / (key + ".part")
                record = dict(meta, part=str(part), offset=0)
                if record.get("sendMode") == "online":
                    record["approval"] = "pending"
                write_record(self._path(key), record)
            elif record.get("canceled"):
                raise TransferError("这项传输已取消", 410)
            elif (record.get("sendMode", "direct") != meta.get("sendMode", "direct")
                  or any(record[k] != meta[k] for k in ("name", "size", "msgId"))
                  or not prepare and record.get("sha256") not in (None, checksum)):
                raise TransferError("这项任务的原文件已变化，需重新发送", 409)
            if not prepare and record.get("sha256") is None:
                record["sha256"] = checksum
                write_record(self._path(key), record)
            if record.get("approval") == "pending":
                if observe and fresh:
                    observe(record, 0, "offered")
                return self._view(record, key)
            if prepare:
                return self._view(record, key)
            if record.get("paused"):
                record["paused"] = False
                write_record(self._path(key), record)
            view = self._view(record, key)
            if observe and not view["complete"]:
                observe(record, view["offset"])
            return view

    def offered(self, key):
        if not isinstance(key, str) or not DIGEST.fullmatch(key):
            raise TransferError("接收邀请不存在", 404)
        record = self._record(key)
        if record.get("approval") != "pending" or record.get("canceled"):
            raise TransferError("该接收邀请状态已变化", 409)
        return record

    def accept(self, key, selected=None, observe=None):
        if not isinstance(key, str) or not DIGEST.fullmatch(key):
            raise TransferError("接收邀请不存在", 404)
        with self._lock(key):
            record = self.offered(key)
            if selected is not None:
                chosen = Path(selected).resolve()
                if not chosen.parent.is_dir() or chosen.is_dir():
                    raise TransferError("另存为位置不可用")
                record["destinationChoice"] = str(chosen)
                record["part"] = str(chosen.parent / ".jinchuan-partials" / (key + ".part"))
            record["approval"] = "accepted"
            write_record(self._path(key), record)
            if observe:
                observe(record, 0, "waiting" if record.get("sha256") else "waiting_source")
            return self._view(record, key)

    def stream(self, source, tid, offset, length, reader, observe=None):
        """Receive one HTTP body, with durable boundaries while it is still arriving."""
        return self._receive(source, tid, offset, length, reader, observe, continuous=True)[0]

    def _take_digest(self, key):
        with self.digest_lock:
            return self.stream_digests.pop(key, None)

    def _remember_digest(self, key, stamp, sha):
        with self.digest_lock:
            self.stream_digests[key] = (stamp, sha)
            if len(self.stream_digests) > 64:
                self.stream_digests.popitem(last=False)

    def control(self, source, tid, action, publish, observe=None):
        key = self.key(source, tid)
        with self._lock(key):
            record = read_record(self._path(key))
            if record and not record.get("canceled"):
                # A previous finish may have moved the file before acknowledging the result.
                # Resolve the committed delivery rather than treating it as deletable partial data.
                part = Path(record["part"])
                if record.get("complete") or (record.get("target") and not part.exists()
                                               and Path(record["target"]).is_file()):
                    return self.finish(source, tid, publish, observe)
            if action == "pause":
                if record is None:
                    return dict(ok=True, offset=0, paused=True, complete=False)
                if record.get("canceled"):
                    raise TransferError("这项传输已取消", 410)
                record["paused"] = True
                write_record(self._path(key), record)
                offset = self._offset(record)
                if observe:
                    observe(record, offset, "paused")
                return dict(ok=True, offset=offset, paused=True, complete=False)
            if action != "cancel":
                raise TransferError("未知传输操作")
            self._take_digest(key)
            # Mark cancellation before deletion so a late append/status can never recreate it.
            tombstone = dict(record or {"from":source, "id":tid}, canceled=True)
            write_record(self._path(key), tombstone)
            if tombstone.get("part"):
                Path(tombstone["part"]).unlink(missing_ok=True)
            write_record(self._path(key), {"from":source, "id":tid, "canceled":True})
            if observe and record and "name" in record:
                observe(record, 0, "canceled")
            return dict(ok=True, offset=0, canceled=True, complete=False)

    def unfinished(self):
        for path in self.directory.glob("*.json"):
            record = read_record(path)
            if record and not record.get("canceled") and not record.get("complete"):
                offset = self._offset(record)
                if offset or record.get("paused") or record.get("approval"):
                    yield record, offset

    def append(self, source, tid, offset, length, reader, observe=None):
        return self._receive(source, tid, offset, length, reader, observe, continuous=False)

    def _receive(self, source, tid, offset, length, reader, observe, *, continuous):
        key = self.key(source, tid)
        if length <= 0 or not continuous and length > NETWORK_CHUNK:
            raise TransferError("文件分块长度无效")
        with self._lock(key):
            record = self._record(key)
            if record.get("canceled"):
                raise TransferError("这项传输已取消", 410)
            previous = self._offset(record)
            if record.get("approval") == "pending":
                raise TransferError("接收端还没有确认接收", 409)
            if record.get("sha256") is None:
                raise TransferError("发送方尚未准备好文件", 409, offset=previous)
            if record.get("paused"):
                raise TransferError("这项传输已暂停，请先继续", 409, offset=previous)
            if record.get("complete") or offset != previous or offset + length > record["size"]:
                raise TransferError("接收端进度已变化", 409, offset=previous)
            self._take_digest(key)
            part = Path(record["part"])
            part.parent.mkdir(parents=True, exist_ok=True)
            if not part.exists():
                part.touch()
            end, committed = offset + length, offset
            # A cold resume must not postpone socket reads to rehash a huge existing prefix.
            # In that case, finish verifies the on-disk file instead.
            sha = hashlib.sha256() if continuous and offset == 0 else None
            with part.open("r+b") as out:
                try:
                    out.truncate(previous)
                    out.seek(previous)
                    tick = time.monotonic()
                    while offset < end:
                        boundary = min(end, offset + NETWORK_CHUNK)
                        while offset < boundary:
                            block = reader.read(min(BUFFER, boundary - offset))
                            if not block:
                                raise TransferError("连接中断，未确认的分块未写入", 409, offset=committed)
                            out.write(block)
                            if sha is not None:
                                sha.update(block)
                            offset += len(block)
                            now = time.monotonic()
                            if observe and now - tick >= .25:
                                observe(record, committed, wire=offset)
                                tick = now
                        out.flush()
                        os.fsync(out.fileno())
                        record["offset"] = boundary
                        write_record(self._path(key), record)
                        committed = boundary
                    if observe:
                        observe(record, committed, wire=committed)
                except (OSError, TransferError):
                    out.truncate(committed)
                    if observe:
                        observe(record, committed, "waiting", error="接收中断，等待对方继续。")
                    raise
            if sha is not None and committed == record["size"]:
                self._remember_digest(key, file_stamp(part), sha.hexdigest())
            return dict(ok=True, offset=committed), record

    def finish(self, source, tid, publish, observe=None):
        key = self.key(source, tid)
        with self._lock(key):
            record = self._record(key)
            if record.get("canceled"):
                raise TransferError("这项传输已取消", 410)
            if not record.get("complete"):
                if record.get("approval") == "pending":
                    raise TransferError("接收端还没有确认接收", 409)
                if record.get("sha256") is None:
                    raise TransferError("发送方尚未准备好文件", 409)
                if record.get("paused"):
                    raise TransferError("这项传输已暂停，请先继续", 409, offset=self._offset(record))
                part = Path(record["part"])
                if record["size"] == 0 and not record.get("target"):
                    part.parent.mkdir(parents=True, exist_ok=True)
                    part.touch(exist_ok=True)
                if self._offset(record) != record["size"]:
                    raise TransferError("文件还没收齐", 409, offset=self._offset(record))
                target = Path(record["target"]) if record.get("target") else None
                verifying = part if part.exists() else target
                if verifying is None or not verifying.is_file():
                    raise TransferError("接收端缺少临时文件", 409)
                if part.is_file() and part.stat().st_size != record["size"]:
                    with part.open("r+b") as stream:
                        stream.truncate(record["size"])
                if observe:
                    observe(record, record["size"], "verifying")
                try:
                    cached = self._take_digest(key)
                    checksum = cached[1] if cached and cached[0] == file_stamp(verifying) else digest_file(verifying)
                except OSError:
                    if observe:
                        observe(record, record["size"], "waiting", error="读取文件失败，等待对方重试。")
                    raise
                if checksum != record["sha256"]:
                    if verifying == part:
                        part.unlink()
                    record.pop("target", None)
                    record["offset"] = 0
                    write_record(self._path(key), record)
                    if observe:
                        observe(record, 0, "waiting", error="文件校验失败，等待对方重试。")
                    raise TransferError("SHA-256 校验未通过，已清除坏数据；重试将从头发送", 422, offset=0)
                with self.commit_lock:
                    if part.exists():
                        if target is None or target.exists():
                            preferred = record.get("destinationChoice")
                            target = self.available_name(Path(preferred) if preferred else part.parent.parent / record["name"])
                        record["target"] = str(target)
                        write_record(self._path(key), record)
                        if os.name == "nt":
                            os.rename(part, target)  # Does not overwrite an existing file on Windows.
                        else:
                            os.replace(part, target)
                    record["complete"] = True
                    write_record(self._path(key), record)
            view = self._view(record, key)
            # 包已收好但最终响应丢失时，重试同一 msgId，消息层负责去重。
            if not record.get("published"):
                publish(record, view["path"])
                record["published"] = True
                write_record(self._path(key), record)
            return view

    def media_path(self, ref):
        bits = ref.split("/", 2)
        if len(bits) != 3 or bits[0] != "received" or not DIGEST.fullmatch(bits[1]):
            return None
        record = read_record(self._path(bits[1]))
        if not record or not record.get("complete"):
            return None
        target = Path(record["target"])
        return target if target.name == bits[2] else None

