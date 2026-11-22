"""Disk-backed, offset-checked receiver for direct single-file transfers."""
import hashlib
import json
import os
import re
import threading
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

    def status(self, meta, observe=None):
        key = self.key(meta.get("from"), meta.get("id"))
        size, checksum = meta.get("size"), meta.get("sha256")
        if type(size) is not int or not 0 <= size < 2**53 or not isinstance(checksum, str) or not DIGEST.fullmatch(checksum):
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
                  or any(record[k] != meta[k] for k in ("name", "size", "sha256", "msgId"))):
                raise TransferError("这项任务的原文件已变化，需重新发送", 409)
            if record.get("approval") == "pending":
                if observe and fresh:
                    observe(record, 0, "offered")
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
                observe(record, 0, "waiting")
            return self._view(record, key)

    def stream(self, source, tid, offset, length, reader, observe=None):
        """Receive one HTTP body, with durable boundaries while it is still arriving."""
        key = self.key(source, tid)
        with self._lock(key):
            record = self._record(key)
            if record.get("canceled"):
                raise TransferError("这项传输已取消", 410)
            if record.get("approval") == "pending":
                raise TransferError("接收端还没有确认接收", 409)
            if length <= 0 or offset != self._offset(record) or offset + length > record["size"]:
                raise TransferError("流式传输范围无效", 409, offset=self._offset(record))
            while length:
                count = min(length, NETWORK_CHUNK)
                self.append(source, tid, offset, count, reader, observe)
                offset += count
                length -= count
            return {"ok": True, "offset": offset}

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
        key = self.key(source, tid)
        if not 0 < length <= NETWORK_CHUNK:
            raise TransferError("文件分块长度无效")
        with self._lock(key):
            record = self._record(key)
            if record.get("canceled"):
                raise TransferError("这项传输已取消", 410)
            previous = self._offset(record)
            if record.get("approval") == "pending":
                raise TransferError("接收端还没有确认接收", 409)
            if record.get("paused"):
                raise TransferError("这项传输已暂停，请先继续", 409, offset=previous)
            if record.get("complete") or offset != previous or offset + length > record["size"]:
                raise TransferError("接收端进度已变化", 409, offset=previous)
            part = Path(record["part"])
            part.parent.mkdir(parents=True, exist_ok=True)
            with part.open("ab") as out:
                try:
                    out.truncate(previous)
                    remaining = length
                    while remaining:
                        block = reader.read(min(BUFFER, remaining))
                        if not block:
                            raise TransferError("连接中断，未确认的分块未写入", 409, offset=previous)
                        out.write(block)
                        remaining -= len(block)
                    out.flush()
                    os.fsync(out.fileno())
                    record["offset"] = previous + length
                    write_record(self._path(key), record)
                except (OSError, TransferError):
                    out.truncate(previous)
                    if observe:
                        observe(record, previous, "waiting", error="接收中断，等待对方继续。")
                    raise
            if observe:
                observe(record, previous + length)
            return dict(ok=True, offset=previous + length), record

    def finish(self, source, tid, publish, observe=None):
        key = self.key(source, tid)
        with self._lock(key):
            record = self._record(key)
            if record.get("canceled"):
                raise TransferError("这项传输已取消", 410)
            if not record.get("complete"):
                if record.get("approval") == "pending":
                    raise TransferError("接收端还没有确认接收", 409)
                if record.get("paused"):
                    raise TransferError("这项传输已暂停，请先继续", 409, offset=self._offset(record))
                part = Path(record["part"])
                if record["size"] == 0 and not record.get("target"):
                    part.parent.mkdir(parents=True, exist_ok=True)
                    part.touch(exist_ok=True)
                if self._offset(record) != record["size"]:
                    raise TransferError("文件还没收齐", 409, offset=self._offset(record))
                if part.is_file():
                    with part.open("r+b") as stream:
                        stream.truncate(record["size"])
                with self.commit_lock:
                    target = Path(record["target"]) if record.get("target") else None
                    verifying = part if part.exists() else target
                    if verifying is None or not verifying.is_file():
                        raise TransferError("接收端缺少临时文件", 409)
                    if observe:
                        observe(record, record["size"], "verifying")
                    try:
                        checksum = digest_file(verifying)
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

