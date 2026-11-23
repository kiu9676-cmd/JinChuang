from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch

import server


class MessageTimelineTest(unittest.TestCase):
    def test_reply_arriving_before_send_ack_is_appended_after_outgoing(self):
        peer = {"ip":"127.0.0.1", "http":8765, "last_seen":time.time()}
        handler = SimpleNamespace(_json=lambda row: row)
        conversation = {"n-peer":[{"msgId":"m-old","dir":"out","time":200}]}
        def deliver(*_args, **_kwargs):
            self.assertEqual(conversation["n-peer"][-1]["status"], "sending")
            server.add_message("n-peer",{"msgId":"m-reply","dir":"in","time":100})
            return 200, {}
        with patch.multiple(server, MESSAGES=conversation, PEERS={"n-peer":peer}, UNREAD={},
                            ME={"id":"n-me","name":"我","avatarKey":"fox"}), patch.object(
                            server,"save_messages"), patch.object(server,"refresh"), patch.object(
                            server,"post_to",side_effect=deliver), patch.object(server,"now_ms",side_effect=[1000,1010]):
            result = server.Handler._api_send(handler, {"to":"n-peer","msgId":"m-send",
                         "time":300,"type":"text","text":"发出"})
            server.add_message("n-peer",{"msgId":"m-reply","dir":"in","localTime":99999})
        rows = conversation["n-peer"]
        self.assertTrue(result["ok"])
        self.assertEqual([x["msgId"] for x in rows], ["m-old","m-send","m-reply"])
        self.assertEqual(rows[1]["status"],"done")
        self.assertEqual([rows[1]["localTime"],rows[2]["localTime"]],[1000,1010])
