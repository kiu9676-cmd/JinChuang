import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest.mock import patch

import server
from local_cache import LocalCache
from transfer_resume import MAX_CHUNK


class LocalTransferTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.data = self.base / "app"
        self.dest = self.base / "external-downloads"
        self.cache = self.data / "cache"
        self.cache.mkdir(parents=True)
        self.dest.mkdir()
        context = patch.multiple(server, DATA_DIR=self.data, DOWNLOAD_DIR=self.dest,
            CACHE_DIR=self.cache, LOCAL_CACHE=LocalCache(self.cache, server.unique_path, server.FILE_LOCK),
            MESSAGES_FILE=self.data / "messages.json", MESSAGES={}, UNREAD={}, TRANSFERS={},
            DESKTOP=None, ME={"id":"n-sender","name":"Sender"}, PEERS={})
        context.start()
        self.addCleanup(context.stop)
        self.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_port
        worker = threading.Thread(target=self.httpd.serve_forever, daemon=True,
                                  kwargs={"poll_interval": 0.02})
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        server.PEERS["n-peer"] = {"ip":"127.0.0.1","http":self.port}

    def request(self, endpoint, body=None, binary=False):
        conn = http.client.HTTPConnection("127.0.0.1",self.port,timeout=5)
        try:
            if body is None:
                conn.request("GET",endpoint)
            else:
                payload = body if binary else json.dumps(body).encode("utf-8")
                conn.request("POST",endpoint,body=payload)
            reply = conn.getresponse()
            payload = reply.read()
            if "application/json" in reply.getheader("Content-Type",""):
                payload = json.loads(payload)
            return reply.status,payload
        finally:
            conn.close()

    def stage(self, name, data, temporary=False):
        code, start = self.request("/api/cache/start",dict(name=name,size=len(data),temporary=temporary))
        self.assertEqual(code,200)
        self.assertEqual(start["chunkSize"],MAX_CHUNK)
        tid = start["id"]
        for offset in range(0,len(data),MAX_CHUNK):
            end = min(offset+MAX_CHUNK,len(data))
            code, body = self.request("/api/cache/append?"+urlencode(dict(id=tid,offset=offset)),data[offset:end],True)
            self.assertEqual((code,body),(200,{"ok":True,"offset":end}))
        code, result = self.request("/api/cache/finish",{"id":tid})
        self.assertEqual(code,200)
        self.assertEqual(result["sha256"],hashlib.sha256(data).hexdigest())
        return result

    def test_archive_is_spooled_in_multiple_bounded_requests(self):
        payload = b"\x17"*(MAX_CHUNK*3+51)
        info = self.stage("archive.zip",payload)
        self.assertEqual((self.cache/"archive.zip").stat().st_size,len(payload))
        status, sent = self.request("/api/transfer/forward",dict(peerId="n-peer",id="archive-1",msgId="m-archive",
            name="archive.zip",rel="archive.zip",path=info["path"],kind="file"))
        self.assertEqual(status,200,sent)
        self.assertEqual(hashlib.sha256((self.dest/"archive.zip").read_bytes()).hexdigest(),info["sha256"])
        self.assertEqual(self.request("/api/download?"+urlencode({"path":sent["path"]})),(200,payload))

    def test_folder_forward_preserves_nested_paths_and_external_downloads(self):
        tid,mid="folder-test","m-folder"
        for i,(rel,payload) in enumerate((("项目/子目录/附件.txt",b"example"),("项目/empty.txt",b""))):
            cached = self.stage("test.txt",payload,temporary=True)
            code, result = self.request("/api/transfer/forward",dict(peerId="n-peer",id=tid,msgId=mid,
                name="test.txt",rel=rel,stageId=cached["stageId"],folder=1,idx=i,count=2,total=7))
            self.assertEqual(code,200,result)
            self.assertEqual(self.request("/api/cache/discard",{"id":cached["stageId"]})[0],200)
            self.assertEqual((self.dest/rel).read_bytes(),payload)
        self.assertEqual(server.resolve_media_path(result["path"]),self.dest/"项目")
        messages=server.MESSAGES["n-sender"]
        self.assertEqual(len(messages),1)
        self.assertEqual(messages[0]["folderPath"],result["path"])
        self.assertEqual(messages[0]["fileCount"],2)
        self.assertEqual(list((self.cache/".local-intake").iterdir()),[])

    def test_receiver_storage_error_survives_server_relay(self):
        blocked=self.base/"not-a-directory"
        blocked.write_text("collision")
        cached=self.stage("test.txt",b"abc",temporary=True)
        with patch.object(server,"DOWNLOAD_DIR",blocked):
            status, result=self.request("/api/transfer/forward",dict(peerId="n-peer",id="t-1",msgId="m-1",
                name="test.txt",rel="folder/test.txt",stageId=cached["stageId"],folder=1,idx=0,count=1,total=3))
        self.assertEqual(status,502)
        self.assertIn("接收端无法创建目录",result["error"])
        self.assertFalse(server.MESSAGES)

    def test_read_ack_does_not_clear_a_newer_inbound_message(self):
        peer="n-peer"
        server.add_message(peer,{"msgId":"m-one","dir":"in"})
        server.add_message(peer,{"msgId":"m-two","dir":"in"})
        status, result=self.request("/api/read",{"id":peer,"through":"m-one"})
        self.assertEqual((status,result),(200,{"ok":True,"stale":True}))
        self.assertEqual(server.UNREAD[peer],2)
        self.assertEqual(self.request("/api/read",{"id":peer,"through":"m-two"}),(200,{"ok":True}))
        self.assertNotIn(peer,server.UNREAD)
