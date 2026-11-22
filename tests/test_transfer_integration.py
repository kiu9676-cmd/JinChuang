"""Two live loopback instances, exercising the real HTTP intake and transport."""
from contextlib import closing, contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import urlencode

from transfer_resume import NETWORK_CHUNK, digest_file

NODE = """
import json, os, sys, threading, time
import server
class PacedInput:
    def __init__(self, reader):
        self.reader = reader
    def read(self, amount):
        if amount >= 64*1024:
            time.sleep(.004)
        return self.reader.read(amount)
class Handler(server.Handler):
    def _api_resume(self, action, query):
        if action in ("stream", "append") and os.getenv("JINCHUANG_TEST_PACE_RECEIVER") == "1":
            source = self.rfile
            try:
                self.rfile = PacedInput(source)
                return super()._api_resume(action, query)
            finally:
                self.rfile = source
        return super()._api_resume(action, query)
with server.Server(("127.0.0.1", 0), Handler) as httpd:
    addr, port = httpd.server_address
    server.primary_ip = lambda: addr
    args = server.build_arg_parser().parse_args(["--data-dir", sys.argv[1], "--http-port", str(port)])
    server.init_store(args)
    if hasattr(server, "outbox_loop"):
        threading.Thread(target=server.outbox_loop, daemon=True).start()
    print(json.dumps(server.ME), flush=True)
    httpd.serve_forever()
"""


@contextmanager
def app(root, paced=False):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", JINCHUANG_TEST_PACE_RECEIVER=str(int(paced)))
    with subprocess.Popen([sys.executable, "-u", "-c", NODE, str(root)],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                          env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as process:
        try:
            identity = json.loads(process.stdout.readline())
            yield identity
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)


def request(node, path, body=None, *, conn=None):
    own = conn is None
    conn = conn or http.client.HTTPConnection(node["ip"], node["http"], timeout=15)
    try:
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        conn.request("GET" if body is None else "POST", path, body=data,
                     headers={"Content-Type": "application/json" if isinstance(body, dict) else "application/octet-stream"})
        with conn.getresponse() as response:
            result = json.loads(response.read())
            if response.status != 200:
                raise AssertionError((path, response.status, result))
            return result
    finally:
        if own:
            conn.close()


def task(node, mid):
    return next((t for t in request(node, "/api/state")["transfers"] if t.get("msgId") == mid), {})


class LiveTransferTests(unittest.TestCase):
    def test_offer_before_local_copy_and_zero_bytes_until_confirmation(self):
        size = int(os.environ.get("JINCHUANG_LARGE_TRANSFER_BYTES") or NETWORK_CHUNK * 2 + 7)
        parent = os.environ.get("JINCHUANG_TRANSFER_TEST_DIR")
        with tempfile.TemporaryDirectory(prefix="jc-live-", dir=parent) as base:
            base = Path(base)
            with app(base/"send") as sender, app(base/"receive", paced=size<128*1024**2) as receiver:
                request(sender, "/api/register", receiver)
                meta = {"peerId": receiver["id"], "kind": "file", "name": "sample.bin",
                        "size": size, "sendMode":"online"}
                begun = request(sender, "/api/transfer/prepare-file", meta)["task"]
                self.assertEqual(begun["status"],"preparing")
                mid = begun["msgId"]
                offer = task(receiver,mid)
                self.assertEqual(offer["status"], "offered")
                self.assertEqual(offer["doneBytes"], 0)
                self.assertFalse(list((base/"send"/"cache").rglob("*.part")))
                self.assertFalse(list((base/"receive"/"downloads").rglob("*.part")))
                request(receiver, "/api/transfer/accept", {"id":offer["id"],"saveAs":False})
                self.assertEqual(task(receiver,mid)["status"],"waiting_source")
                self.assertEqual(task(sender,mid)["status"],"preparing")

                started = time.perf_counter()
                intake = request(sender, "/api/cache/start", meta)
                width = intake["chunkSize"]
                self.assertEqual(width, NETWORK_CHUNK)
                pattern = bytes(range(256)) * (width // 256)
                sha = hashlib.sha256()
                requests = 0
                with closing(http.client.HTTPConnection(sender["ip"],sender["http"],timeout=30)) as conn:
                    for offset in range(0,size,width):
                        piece = pattern[:min(width,size-offset)]
                        q = urlencode({"id":intake["id"],"offset":offset})
                        self.assertEqual(request(sender,"/api/cache/append?"+q,piece,conn=conn)["offset"],offset+len(piece))
                        sha.update(piece)
                        requests += 1
                    cached = request(sender,"/api/cache/finish",{"id":intake["id"]},conn=conn)
                self.assertEqual(cached["sha256"],sha.hexdigest())
                local_time = time.perf_counter()-started
                self.assertEqual(task(receiver,mid)["status"],"waiting_source")
                started = time.perf_counter()
                request(sender, "/api/transfer/send-file",dict(meta,**cached,preparedId=begun["id"]))
                peak = [0,0]
                for _ in range(10000):
                    sending, receiving = task(sender,mid), task(receiver,mid)
                    for i,t in enumerate((sending,receiving)):
                        peak[i] = max(peak[i], t.get("speed",0))
                        self.assertNotEqual(t.get("status"),"error",t)
                    if sending["status"] == receiving["status"] == "done":
                        break
                    time.sleep(.06)
                wire_time = time.perf_counter()-started
                self.assertEqual(sending["doneBytes"],size)
                self.assertEqual(receiving["doneBytes"],size)
                self.assertEqual(receiving["status"],"done")
                self.assertEqual(sending["status"],"done")
                self.assertGreater(min(peak),0)
                delivered = base/"receive"/"downloads"/meta["name"]
                self.assertEqual(delivered.stat().st_size,size)
                self.assertEqual(digest_file(delivered),sha.hexdigest())
                print(f"Live loopback: {size:,} bytes, preparation {local_time:.2f}s ({requests} requests), "
                      f"transport and verify {wire_time:.2f}s; both endpoints reported speed",flush=True)
