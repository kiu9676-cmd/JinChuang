import hashlib
import io
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import server
from transfer_resume import ChunkStore, MAX_CHUNK, TransferError, write_record


class ResumeReceiverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "app"
        self.downloads = Path(self.tmp.name) / "my-downloads"
        self.store = self.make_store()
        self.body = b"123456789"
        self.meta = {"from": "n-one", "id": "t-one", "name": "sample.bin",
                     "msgId": "m-one", "size": len(self.body),
                     "sha256": hashlib.sha256(self.body).hexdigest()}
        self.published = []

    def make_store(self):
        return ChunkStore(self.data, lambda: self.downloads, server.unique_path)

    def publish(self, record, ref):
        self.published.append((record["msgId"], ref))

    def append(self, offset, payload, length=None):
        return self.store.append("n-one", "t-one", offset,
                                 len(payload) if length is None else length, io.BytesIO(payload))[0]

    def finish(self):
        return self.store.finish("n-one", "t-one", self.publish)

    def test_resume_exact_confirmed_offset_after_restart(self):
        self.assertEqual(self.store.status(self.meta)["offset"], 0)
        self.assertEqual(self.append(0, self.body[:4])["offset"], 4)
        # Simulate a process exiting after bytes reached disk but before committing that chunk.
        part = next((self.downloads / ".jinchuan-partials").glob("*.part"))
        with part.open("ab") as stream:
            stream.write(b"unconfirmed")
        self.store = self.make_store()
        self.assertEqual(self.store.status(self.meta)["offset"], 4)
        self.assertEqual(self.append(4, self.body[4:])["offset"], 9)
        ref = self.finish()["path"]
        self.assertEqual(self.store.media_path(ref).read_bytes(), self.body)
        self.assertEqual(self.make_store().finish("n-one", "t-one", self.publish)["path"], ref)
        self.assertEqual(self.published, [("m-one", ref)])

    def test_interrupted_chunk_wrong_offset_and_bounds(self):
        self.store.status(self.meta)
        with self.assertRaises(TransferError) as early:
            self.append(0, b"123", length=4)
        self.assertEqual(early.exception.detail["offset"], 0)
        self.assertEqual(self.store.status(self.meta)["offset"], 0)
        with self.assertRaises(TransferError) as offset:
            self.append(3, b"4")
        self.assertEqual(offset.exception.status, 409)
        with self.assertRaises(TransferError):
            self.append(0, b"", length=MAX_CHUNK + 1)
        with self.assertRaises(TransferError):
            self.finish()
        self.assertEqual(self.published, [])

    def test_corruption_resets_without_publishing(self):
        self.store.status(self.meta)
        self.append(0, b"987654321")
        with self.assertRaises(TransferError) as sha:
            self.finish()
        self.assertEqual(sha.exception.status, 422)
        self.assertEqual(self.store.status(self.meta)["offset"], 0)
        self.assertFalse((self.downloads / self.meta["name"]).exists())
        self.assertEqual(self.published, [])
        self.append(0, self.body)
        self.assertTrue(self.finish()["complete"])

    def test_empty_file_no_overwrite_and_reference_after_directory_change(self):
        self.meta.update(size=0, sha256=hashlib.sha256(b"").hexdigest())
        self.downloads.mkdir()
        occupied = self.downloads / self.meta["name"]
        occupied.write_bytes(b"keep")
        self.store.status(self.meta)
        ref = self.finish()["path"]
        previous = self.downloads
        self.downloads = Path(self.tmp.name) / "next-downloads"
        recovered = self.make_store().media_path(ref)
        self.assertEqual(recovered.parent, previous)
        self.assertEqual(recovered.read_bytes(), b"")
        self.assertEqual(occupied.read_bytes(), b"keep")

    def test_pause_freezes_committed_offset_after_restart(self):
        self.store.status(self.meta)
        self.append(0, self.body[:4])
        paused = self.store.control("n-one", "t-one", "pause", self.publish)
        self.assertTrue(paused["paused"])
        self.assertEqual(paused["offset"], 4)
        self.store = self.make_store()
        (record, offset), = self.store.unfinished()
        self.assertTrue(record["paused"])
        self.assertEqual(offset, 4)
        with self.assertRaises(TransferError):
            self.append(4, self.body[4:])
        self.assertEqual(self.store.status(self.meta)["offset"], 4)
        self.append(4, self.body[4:])
        self.assertTrue(self.finish()["complete"])

    def test_cancel_cleans_part_and_blocks_late_requests(self):
        self.store.status(self.meta)
        self.append(0, self.body[:4])
        part, = list((self.downloads / ".jinchuan-partials").glob("*.part"))
        state = self.store.control("n-one", "t-one", "cancel", self.publish)
        self.assertTrue(state["canceled"])
        self.assertFalse(part.exists())
        self.store = self.make_store()
        self.assertTrue(self.store.control("n-one", "t-one", "cancel", self.publish)["canceled"])
        for late in [lambda: self.store.status(self.meta), lambda: self.append(0, b"1234"), self.finish]:
            with self.assertRaises(TransferError) as error:
                late()
            self.assertEqual(error.exception.status, 410)
        self.assertEqual(list(self.store.unfinished()), [])
        self.assertEqual(self.published, [])

    def test_cancel_does_not_delete_verified_file(self):
        self.store.status(self.meta)
        self.append(0, self.body)
        delivery = self.finish()
        state = self.store.control("n-one", "t-one", "cancel", self.publish)
        self.assertEqual(state, delivery)
        self.assertEqual(self.store.media_path(delivery["path"]).read_bytes(), self.body)
        self.assertEqual(len(self.published), 1)

    def test_cancel_before_status_rejects_late_start(self):
        self.assertTrue(self.store.control("n-one", "t-one", "cancel", self.publish)["canceled"])
        with self.assertRaises(TransferError) as error:
            self.store.status(self.meta)
        self.assertEqual(error.exception.status, 410)


class ResumeSenderTest(unittest.TestCase):
    def test_interrupted_job_is_restored_as_manual_retry_without_losing_offset(self):
        with tempfile.TemporaryDirectory() as root, patch.multiple(
                server, DATA_DIR=Path(root), OUTBOX={}, TRANSFERS={}):
            write_record(server.outbox_record("t-1"), {"id": "t-1", "status": "running",
                         "doneBytes": MAX_CHUNK, "retryable": True})
            write_record(server.outbox_record("t-2"), {"id": "t-2", "status": "done",
                         "dismissed": True})
            server.load_outbox()
            self.assertEqual(server.TRANSFERS["t-1"]["status"], "error")
            self.assertEqual(server.TRANSFERS["t-1"]["doneBytes"], MAX_CHUNK)
            self.assertIn("t-2", server.OUTBOX)
            self.assertNotIn("t-2", server.TRANSFERS)

    def test_restart_preserves_paused_job_and_cleanup_intent(self):
        with tempfile.TemporaryDirectory() as root, patch.multiple(
                server, DATA_DIR=Path(root), OUTBOX={}, OUTBOX_ACTIVE=set(), TRANSFERS={}):
            for name in ("pausing", "paused", "canceling", "verifying"):
                write_record(server.outbox_record(name), {"id": name, "status": name,
                             "doneBytes": MAX_CHUNK, "retryable": True, "control": True})
            server.load_outbox()
            states = {tid: row["status"] for tid, row in server.TRANSFERS.items()}
            self.assertEqual(states, {"pausing":"paused", "paused":"paused",
                                      "canceling":"cancel_wait", "verifying":"error"})
            self.assertEqual(server.OUTBOX_ACTIVE, set())
            self.assertEqual(server.TRANSFERS["paused"]["doneBytes"], MAX_CHUNK)

    def test_two_canceled_jobs_sharing_cache_remove_it_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.mkdir()
            file = cache / "shared.bin"
            file.write_bytes(b"123")
            tasks = {tid: {"id": tid, "status":"canceling", "path":"cache/shared.bin",
                           "remoteStarted":False} for tid in ("t-a", "t-b")}
            with patch.multiple(server, DATA_DIR=root, CACHE_DIR=cache, OUTBOX=tasks,
                                TRANSFERS={}, MESSAGES={}):
                with ThreadPoolExecutor(max_workers=2) as workers:
                    list(workers.map(lambda t: server.pause_or_cancel_outbox(t, "cancel"), tasks.values()))
                self.assertTrue(all(task["status"] == "canceled" for task in tasks.values()))
                self.assertFalse(file.exists())

    def test_verifying_and_legacy_tasks_reject_unsafe_controls(self):
        with patch.object(server, "OUTBOX", {"t-1":{"status":"verifying","control":True},
                                            "t-2":{"status":"running","control":False}}):
            for tid in ("t-1", "t-2"):
                for action in ("pause", "cancel"):
                    with self.assertRaises(TransferError) as error:
                        server.control_outbox(tid, action)
                    self.assertEqual(error.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
