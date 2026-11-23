import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class ReleaseAssetTests(unittest.TestCase):
    def test_update_url_uses_published_asset_when_github_api_is_limited(self):
        with patch.object(server, "latest_tag_via_redirect", return_value="v1.6.2"), patch.object(server.platform, "system", return_value="Windows"):
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


    def test_platform_asset_selection_requires_a_verified_and_compatible_pkg(self):
        tag = "v1.6.8"
        def row(name, sha=True):
            value = {"name":name,"browser_download_url":"https://github.com/example/releases/download/"+name,"size":100}
            if sha:
                value["digest"] = "sha256:" + "b"*64
            return value
        arm = "JinChuan-v1.6.8-macOS-arm64.pkg"
        intel = "JinChuan-v1.6.8-macOS-x86_64.pkg"
        ventura = "JinChuan-v1.6.8-macOS-Ventura-x86_64.pkg"
        def pick(arch, ver, *rows):
            with patch.multiple(server.platform, system=lambda:"Darwin", mac_ver=lambda:(ver,(),""), machine=lambda:arch):
                return server.release_asset({"assets":list(rows)},tag)
        self.assertEqual(pick("x86_64","13.7.8",row(arm),row(intel),row(ventura))["name"],ventura)
        self.assertEqual(pick("arm64","15.2",row(ventura),row(arm))["name"],arm)
        self.assertEqual(pick("x86_64","15.2",row(arm),row(intel))["name"],intel)
        self.assertIsNone(pick("x86_64","13.7.8",row("default.exe"),row(intel),row(ventura,False)))
        self.assertIsNone(pick("arm64","14.7",row(arm)))
        with patch.object(server.platform,"system",return_value="Windows"):
            self.assertEqual(server.release_asset({"assets":[row(arm),row("default.exe")]},tag)["name"],"default.exe")

    def test_pkg_opens_native_installer_and_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()
            dst=root/"update"/"candidate.pkg"
            dst.parent.mkdir()
            dst.write_bytes(b"xar! installer")
            state=dict(server.UPDATE,state="ready",kind="pkg",path=str(dst),
                       checksum=hashlib.sha256(dst.read_bytes()).hexdigest())
            with patch.multiple(server,DATA_DIR=root,UPDATE=state), patch.object(
                    server.platform,"system",return_value="Darwin"), patch.object(
                    server.sys,"frozen",True,create=True), patch.object(server.subprocess,"run") as launch:
                self.assertTrue(server.apply_update()[0])
                self.assertEqual(launch.call_args.args[0], ["/usr/bin/open","-a","Installer",str(dst)])
                launch.reset_mock()
                dst.write_bytes(b"changed")
                self.assertFalse(server.apply_update()[0])
                launch.assert_not_called()
