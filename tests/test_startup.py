import socket
import sys
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
import server


class OldServer(ThreadingHTTPServer):
    allow_reuse_address = True


@unittest.skipUnless(sys.platform == "win32", "Windows socket binding behavior")
class StartupTests(unittest.TestCase):
    def test_new_server_rejects_legacy_second_listener(self):
        with server.Server(("127.0.0.1", 0), server.Handler) as first:
            port = first.server_address[1]
            with self.assertRaises(OSError):
                OldServer(("127.0.0.1", port), server.Handler)

    def test_old_listener_blocks_new_start_before_store_load(self):
        with OldServer(("0.0.0.0", 0), server.Handler) as first:
            port = first.server_address[1]
            with tempfile.TemporaryDirectory() as temp, patch.object(server, "init_store") as init:
                args = server.build_arg_parser().parse_args(["--data-dir", temp, "--http-port", str(port)])
                with self.assertRaisesRegex(server.ListenError, "已被占用"):
                    server.boot(args)
                init.assert_not_called()
                self.assertFalse((Path(temp) / "config.json").exists())

    def test_same_port_can_be_used_after_exit(self):
        first = server.Server(("127.0.0.1", 0), server.Handler)
        port = first.server_address[1]
        self.assertEqual(first.socket.getsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE), 1)
        first.server_close()
        with server.Server(("127.0.0.1", port), server.Handler):
            pass
