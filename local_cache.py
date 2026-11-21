"""Bounded, same-origin intake of local browser File slices."""
import hashlib
import secrets
import threading

from transfer_resume import MAX_CHUNK, TransferError


class LocalCache:
    def __init__(self, cache, available_name, publish_lock):
        self.directory = cache / ".local-intake"
        self.available_name = available_name
        self.publish_lock = publish_lock
        self.jobs = {}
        self.lock = threading.RLock()

    def start(self, name, size, temporary=False):
        if type(size) is not int or not 0 <= size < 2**53:
            raise TransferError("文件大小无效")
        with self.lock:
            tid = secrets.token_hex(16)
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / (tid + ".part")
            path.open("xb").close()
            self.jobs[tid] = dict(name=name, size=size, offset=0, path=path, temporary=temporary,
                                  digest=hashlib.sha256(), lock=threading.RLock(), ready=False)
        return {"ok": True, "id": tid, "chunkSize": MAX_CHUNK}

    def job(self, tid):
        with self.lock:
            job = self.jobs.get(tid) if isinstance(tid, str) else None
        if not job:
            raise TransferError("本机缓存任务不存在，请重新发送", 404)
        return job

    def append(self, tid, offset, length, reader):
        job = self.job(tid)
        with job["lock"]:
            if (job["ready"] or offset != job["offset"] or not 0 < length <= MAX_CHUNK
                    or offset + length > job["size"]):
                raise TransferError("本机文件缓存进度不匹配", 409, offset=job["offset"])
            block = reader.read(length)
            if len(block) != length:
                raise TransferError("本机文件读取中断", 400)
            with job["path"].open("r+b") as stream:
                stream.seek(offset)
                stream.write(block)
                stream.truncate(offset + length)
            job["digest"].update(block)
            job["offset"] += length
            return {"ok": True, "offset": job["offset"]}

    def finish(self, tid):
        job = self.job(tid)
        with job["lock"]:
            if job["offset"] != job["size"]:
                raise TransferError("本机文件尚未完整读取", 409)
            info = {"ok": True, "size":job["size"], "sha256":job["digest"].hexdigest()}
            if job["temporary"]:
                job["ready"] = True
                return dict(info, stageId=tid)
            with self.lock, self.publish_lock:
                target = self.available_name(self.directory.parent / job["name"])
                job["path"].replace(target)
                self.jobs.pop(tid)
            return dict(info, path="cache/" + target.name)

    def open_temporary(self, tid):
        job = self.job(tid)
        with job["lock"]:
            if not (job["ready"] and job["temporary"]):
                raise TransferError("本机文件尚未就绪", 409)
            return job["path"].open("rb"), job["size"]

    def discard(self, tid):
        with self.lock:
            job = self.jobs.get(tid) if isinstance(tid, str) else None
        if not job:
            return
        with job["lock"], self.lock:
            if self.jobs.get(tid) is job:
                job["path"].unlink(missing_ok=True)
                del self.jobs[tid]
