import hashlib
import io
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from transfer_resume import ChunkStore, TransferError


class FileModeTest(unittest.TestCase):
    def test_pending_offer_refuses_file_bytes_and_finish(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            dest = root / "downloads"
            chunk = ChunkStore(root, lambda: dest, server.unique_path)
            content = b"accepted only"
            meta = {"from":"n-src","id":"t-file","name":"example.txt","size":len(content),
                    "sha256":hashlib.sha256(content).hexdigest(),"msgId":"m-chat","sendMode":"online"}
            result = chunk.status(meta)
            self.assertEqual(result["approval"],"pending")
            self.assertFalse(dest.exists())
            for send in (
                lambda: chunk.append("n-src","t-file",0,len(content),io.BytesIO(content)),
                lambda: chunk.stream("n-src","t-file",0,len(content),io.BytesIO(content)),
                lambda: chunk.finish("n-src","t-file",lambda *_:None),
            ):
                with self.assertRaisesRegex(TransferError, "没有确认"):
                    send()
            with self.assertRaises(TransferError):
                chunk.status(dict(meta,sendMode="direct"))
            self.assertEqual(chunk.status(meta)["offset"],0)
            (root/"name.txt").write_bytes(b"already there")
            chunk.accept(chunk.key("n-src","t-file"), root/"name.txt")
            self.assertEqual(chunk.status(meta)["approval"],"accepted")
            chunk.stream("n-src","t-file",0,len(content),io.BytesIO(content))
            saved=chunk.finish("n-src","t-file",lambda *_:None)
            self.assertEqual(chunk.media_path(saved["path"]).read_bytes(),content)
            self.assertEqual((root/"name.txt").read_bytes(),b"already there")

    def test_early_offer_can_be_accepted_without_creating_a_partial(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            chunk = ChunkStore(root, lambda: root/"downloads", server.unique_path)
            meta = {"from":"n-src","id":"t-file","name":"test.txt","size":3,
                    "sha256":None,"msgId":"m-chat","sendMode":"online"}
            observe = []
            watch = lambda rec, offset, status="running", **kw: observe.append(status)
            self.assertEqual(chunk.status(meta,watch,prepare=True)["approval"],"pending")
            self.assertEqual(chunk.status(meta,watch,prepare=True)["approval"],"pending")
            self.assertEqual(observe,["offered"])
            chunk.accept(chunk.key("n-src","t-file"),observe=watch)
            self.assertEqual(observe[-1], "waiting_source")
            self.assertFalse((root/"downloads").exists())
            with self.assertRaisesRegex(TransferError, "尚未准备"):
                chunk.stream("n-src","t-file",0,3,io.BytesIO(b"abc"))
            with self.assertRaisesRegex(TransferError, "尚未准备"):
                chunk.finish("n-src","t-file",lambda *_:None)
            sealed = dict(meta,sha256=hashlib.sha256(b"abc").hexdigest())
            self.assertEqual(chunk.status(sealed)["approval"],"accepted")
            chunk.stream("n-src","t-file",0,3,io.BytesIO(b"abc"))
            with patch("transfer_resume.digest_file",side_effect=AssertionError("Normal stream should not reread")):
                self.assertTrue(chunk.finish("n-src","t-file",lambda *_:None)["complete"])

    def test_stream_detects_file_modified_after_writing(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            chunk = ChunkStore(root, lambda: root/"downloads", server.unique_path)
            meta = {"from":"n-src","id":"t-file","name":"test.txt","size":3,
                    "sha256":hashlib.sha256(b"abc").hexdigest(),"msgId":"m-chat"}
            chunk.status(meta)
            chunk.stream("n-src","t-file",0,3,io.BytesIO(b"abc"))
            part = next((root/"downloads").rglob("*.part"))
            part.write_bytes(b"bad")
            import os
            os.utime(part,ns=(part.stat().st_atime_ns,part.stat().st_mtime_ns+2_000_000_000))
            with self.assertRaisesRegex(TransferError,"SHA-256"):
                chunk.finish("n-src","t-file",lambda *_:None)

    def test_stream_abort_only_commits_whole_disk_checkpoints(self):
        with tempfile.TemporaryDirectory() as root, patch("transfer_resume.NETWORK_CHUNK",8):
            root=Path(root)
            chunk=ChunkStore(root,lambda:root/"downloads",server.unique_path)
            content=b"12345678abcdefgh01234567"
            meta={"from":"n-src","id":"t-file","name":"test.txt","size":len(content),
                  "sha256":hashlib.sha256(content).hexdigest(),"msgId":"m-chat"}
            chunk.status(meta)
            with self.assertRaises(TransferError):
                chunk.stream("n-src","t-file",0,len(content),io.BytesIO(content[:9]))
            self.assertEqual(chunk.status(meta)["offset"],8)
            self.assertEqual(chunk.stream("n-src","t-file",8,16,io.BytesIO(content[8:]))["offset"],24)
            result=chunk.finish("n-src","t-file",lambda *_:None)
            self.assertEqual(chunk.media_path(result["path"]).read_bytes(),content)

    def test_offline_queue_survives_restart_and_waits_for_discovery(self):
        with tempfile.TemporaryDirectory() as base:
            base=Path(base).resolve()
            cache=base/"cache"
            cache.mkdir()
            (cache/"queued.txt").write_bytes(b"abc")
            peer={"id":"n-peer","resume":True,"receiveModes":True,"transferControl":True,"last_seen":0}
            with patch.multiple(server, DATA_DIR=base, CACHE_DIR=cache, PEERS={"n-peer":peer},
                                OUTBOX={}, OUTBOX_ACTIVE=set(), TRANSFERS={}), patch.object(
                                server,"start_outbox_worker") as worker:
                task=server.start_outbox({"peerId":"n-peer","path":"cache/queued.txt","size":3,
                    "sha256":hashlib.sha256(b"abc").hexdigest(),"sendMode":"offline","name":"queued.txt"})
                self.assertEqual(task["status"],"queued")
                server.load_outbox()
                self.assertEqual(server.OUTBOX[task["id"]]["sendMode"],"offline")
                server.schedule_outbox()
                worker.assert_not_called()
                peer["last_seen"]=time.time()
                server.schedule_outbox()
                self.assertEqual(worker.call_args.args[0]["id"],task["id"])
