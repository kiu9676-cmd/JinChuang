import unittest
from unittest.mock import patch

import server


class ReleaseAssetTests(unittest.TestCase):
    def test_update_url_uses_published_asset_when_github_api_is_limited(self):
        with patch.object(server, "latest_tag_via_redirect", return_value="v1.6.2"):
            result = server.fallback_release_info("kiu9676-cmd/JinChuang")
        self.assertEqual(result["asset"]["name"], "default.exe")
        self.assertEqual(result["asset"]["url"],
            "https://github.com/kiu9676-cmd/JinChuang/releases/download/v1.6.2/default.exe")


    def test_update_notes_strip_install_instructions_and_download_metadata(self):
        notes = """## Windows
- 单聊同步显示速度。
- **在线邀请**提前显示。
- 依赖许可：见附件
- [对应源码](https://example.test/repo)
- **升级**：替换文件。
- SHA-256: 1234
Windows 附件 SHA-256：1234
"""
        self.assertEqual(server.release_changes(notes),["单聊同步显示速度。","在线邀请提前显示。"])
