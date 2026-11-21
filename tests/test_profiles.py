import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import server


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        args = server.build_arg_parser().parse_args(["--data-dir", self.temp.name, "--name", "本机"])
        with patch.object(server, "primary_ip", return_value="127.0.0.1"):
            server.init_store(args)

    def test_profile_uses_known_avatar_and_restores_from_disk(self):
        self.assertTrue(server.apply_profile_fields({"name": " 小林 ", "avatarKey": "panda"}))
        server.save_json(server.CONFIG_FILE, server.CONFIG)
        args = server.build_arg_parser().parse_args(["--data-dir", self.temp.name])
        with patch.object(server, "primary_ip", return_value="127.0.0.1"):
            server.init_store(args)
        self.assertEqual((server.ME["name"], server.ME["avatarKey"]), ("小林", "panda"))
        self.assertFalse(server.apply_profile_fields({"avatarKey": "unknown"}))
        self.assertEqual(server.ME["avatarKey"], "panda")

    def test_update_peer_preserves_local_alias(self):
        base = {"id": "peer-test", "app": server.APP_NAME, "name": "好友", "http": 8766}
        server.update_peer(base, "127.0.0.1")
        server.PEERS[base["id"]]["alias"] = "我的备注"
        server.update_peer(dict(base, name="新名字", avatarKey="robot"), "127.0.0.1")
        peer = server.PEERS[base["id"]]
        self.assertEqual((peer["name"], peer["alias"], peer["avatarKey"]), ("新名字", "我的备注", "robot"))
        server.update_peer(base, "127.0.0.1")  # Older peers omit the preset id.
        self.assertEqual(peer["avatarKey"], "robot")
        with patch.object(server, "post_to", return_value=(200, {})) as post:
            server.announce_profile_to_peers()
        self.assertEqual(post.call_args.args[2]["avatarKey"], "fox")

    def test_preset_catalog_has_bundled_artwork(self):
        root = Path(server.WEB_DIR) / "avatars"
        self.assertEqual(len(server.AVATAR_KEYS), 6)
        for key in (*server.AVATAR_KEYS, "group"):
            self.assertTrue((root / (key + ".svg")).is_file(), key)


if __name__ == "__main__":
    unittest.main()
