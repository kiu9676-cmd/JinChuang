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
