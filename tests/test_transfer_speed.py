"""Regression tests for source negotiation, download integrity, and transport batching."""
from contextlib import contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import server
from transfer_resume import MAX_CHUNK, NETWORK_CHUNK, ChunkStore, digest_file
from update_download import BUFFER, DownloadCancelled, DownloadError, download_package


class QuietHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def serve(handler, **params):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as httpd:
        vars(httpd).update(params)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval":.02}, daemon=True)
        thread.start()
        try:
            yield httpd
        finally:
            httpd.shutdown()
            thread.join(2)


class UpdateSource(QuietHandler):
    def do_GET(self):
        if self.path == "/start":
            self.send_response(302)
            self.send_header("Location", "/download")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        assert self.path == "/download"
        fixture = self.server
        content = fixture.content
        selection = self.headers.get("Range")
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", selection or "")
        status = 206 if match and fixture.accepts_ranges else 200
        a, b = map(int, match.groups()) if status == 206 else (0, len(content)-1)
        assert 0 <= a <= b < len(content)
        active = status == 206 and b > a
        with fixture.lock:
            fixture.calls.append((a, b, status))
            if active:
                fixture.active += 1
                fixture.peak = max(fixture.peak, fixture.active)
            cut = active and fixture.interrupt
            if cut:
                fixture.interrupt = False
        try:
            self.send_response(status)
            self.send_header("Content-Length", str(b - a + 1))
            self.send_header("ETag", '"test-asset"')
            if fixture.accepts_ranges:
                self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                reported_a = a + 1 if fixture.wrong_range and active and a > 0 else a
                self.send_header("Content-Range", f"bytes {reported_a}-{b}/{len(content)}")
            self.end_headers()
            if active or fixture.slow:
                time.sleep(.13 if fixture.slow and not active else .04)
            last = min(a+BUFFER-1,b) if cut else b
            for pos in range(a,last+1,BUFFER):
                self.wfile.write(content[pos:min(pos+BUFFER,last+1)])
            if cut:
                self.connection.shutdown(socket.SHUT_WR)
                self.close_connection = True
        except ConnectionError:
            self.close_connection = True
        finally:
            if active:
                with fixture.lock:
                    fixture.active -= 1


class ParallelUpdateTest(unittest.TestCase):
    def copy(self, *, accepts=True, digest=None, stop=None, wrong_range=False, interrupt=False, slow=False):
        content = b"MZ" + bytes(range(256)) * (40960+1)
        with tempfile.TemporaryDirectory() as temp, serve(
                UpdateSource, accepts_ranges=accepts, content=content, wrong_range=wrong_range,
                interrupt=interrupt, slow=slow, lock=threading.Lock(), active=0, peak=0, calls=[]) as httpd:
            out = Path(temp)/"update.part"
            agent="JinChuang-test"
            stop=stop or threading.Event()
            ticks=[]
            with patch("update_download.SAMPLE_TIME", .02 if slow else .55):
                total=download_package(f"http://127.0.0.1:{httpd.server_port}/start",out,len(content),
                                       digest or sha256(content).hexdigest(),agent,stop,
                                       lambda *args:ticks.append(args))
            self.assertEqual(total,len(content))
            self.assertEqual(out.read_bytes(),content)
            self.assertEqual(ticks[-1][0],len(content))
            self.assertTrue(all(a[0]<=b[0] for a,b in zip(ticks,ticks[1:])))
            return httpd.calls,httpd.peak,ticks[-1][2]

    def test_three_ranges_and_retry_only_the_unreceived_bytes(self):
        calls,peak,mode=self.copy(interrupt=True,slow=True)
        self.assertEqual(calls[0],(0,2 + 256 * (40960+1)-1,200))
        self.assertGreaterEqual(peak,2)
        self.assertEqual(mode,3)
        self.assertEqual(len(calls),4)
        self.assertTrue(any(a+BUFFER==c and b==d for a,b,_ in calls for c,d,_ in calls))

    def test_200_stream_is_consumed_without_restarting_download(self):
        calls,peak,mode=self.copy(accepts=False)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][2],200)
        self.assertEqual(mode,1)

    def test_fast_link_stays_single_even_when_ranges_are_available(self):
        calls,_,mode=self.copy()
        self.assertEqual(len(calls),1)
        self.assertEqual(mode,1)

    def test_reject_mismatched_ranges_and_digests(self):
        with self.assertRaisesRegex(DownloadError,"指定分段"):
            self.copy(wrong_range=True,slow=True)
        with self.assertRaisesRegex(DownloadError,"SHA-256"):
            self.copy(digest="0"*64)

    def test_cancellation_does_not_finish(self):
        cancelled=threading.Event()
        cancelled.set()
        with self.assertRaises(DownloadCancelled):
            self.copy(stop=cancelled)


class ResumeReceiver(QuietHandler):
    def do_POST(self):
        path=urlsplit(self.path)
        length=int(self.headers["Content-Length"])
        if path.path.endswith("/append"):
            args={k:v[0] for k,v in parse_qs(path.query).items()}
            self.server.parts.append((length,self.client_address[1]))
            result,_=self.server.store.append(args["from"],args["id"],int(args["offset"]),length,self.rfile)
            time.sleep(self.server.receipt_delay)
        else:
            data=json.loads(self.rfile.read(length))
            if path.path.endswith("/register"):
                result={"id":"n-peer","resume":True,"transferControl":True}
                if self.server.limit:
                    result["resumeMaxChunk"]=self.server.limit
            elif path.path.endswith("/status"):
                result=self.server.store.status(data)
            elif path.path.endswith("/finish"):
                result=self.server.store.finish(data["from"],data["id"],lambda *_:None)
            else:
                raise ValueError(self.path)
        self.reply(result)


class LanSpeedTest(unittest.TestCase):
    def transfer(self, size, limit):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root).resolve()
            peer_dir=root/"peer"
            dest=peer_dir/"downloads"
            source=root/"cache"/"file.bin"
            source.parent.mkdir()
            with source.open("wb") as f:
                f.truncate(size)
            checksum=digest_file(source)
            recv=ChunkStore(peer_dir,lambda:dest,server.unique_path)
            with serve(ResumeReceiver,store=recv,parts=[],limit=limit,receipt_delay=.060) as httpd:
                task=dict(id="t-file",peerId="n-peer",direction="out",kind="file",name=source.name,
                          size=size,doneBytes=0,speed=0,status="running",path="cache/file.bin",
                          sha256=checksum,msgId="m-file",start=time.time(),time=server.now_ms(),reply=None)
                with patch.multiple(server, DATA_DIR=root, PEERS={"n-peer":{"ip":"127.0.0.1","http":httpd.server_port}},
                                    ME={"id":"n-from","name":"test"}, MESSAGES={}, TRANSFERS={},
                                    MESSAGES_FILE=root/"messages.json", DESKTOP=None):
                    before=time.perf_counter()
                    server.send_outbox_data(task)
                    elapsed=time.perf_counter()-before
                    self.assertEqual(task["status"],"done")
                self.assertEqual(digest_file(dest/"file.bin"),checksum)
                return httpd.parts,elapsed

    def test_lan_reuses_connection_with_adaptive_batches(self):
        size=64*1024*1024
        legacy,before=self.transfer(size,None)
        modern,after=self.transfer(size,NETWORK_CHUNK)
        self.assertEqual(len(legacy),16)
        self.assertEqual(len({port for _,port in legacy}),1)
        self.assertEqual(len({port for _,port in modern}),1)
        self.assertLess(len(modern),len(legacy)//2)
        self.assertEqual(sum(length for length,_ in modern),size)
        self.assertTrue(all(0<length<=NETWORK_CHUNK for length,_ in modern))
        print(f"LAN 64MiB with injected 60ms per receipt: {len(legacy)} receipts / {before:.2f}s "
              f"vs {len(modern)} receipts / {after:.2f}s",flush=True)

