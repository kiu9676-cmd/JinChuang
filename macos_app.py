"""macOS Cocoa/WebKit launcher; the existing LAN service stays unchanged."""
import sys
from pathlib import Path

import webview
import webview.platforms.cocoa  # Explicitly include the native renderer in the frozen app.
from AppKit import NSAlert
from PIL import ImageGrab

import server
from desktop import DesktopBridge


class MacBridge(DesktopBridge):
    def choose_save_path(self, name):
        if self.main is None:
            return None
        result = self.main.create_file_dialog(webview.FileDialog.SAVE, save_filename=name)
        if isinstance(result, tuple):
            result = result[0] if result else None
        return result if isinstance(result, str) and result else None

    def screenshot(self):
        try:
            with ImageGrab.grab() as image:
                dest = server.CACHE_DIR / (server.new_id("screenshot-") + ".png")
                image.save(dest)
            return dest.relative_to(server.DATA_DIR).as_posix()
        except OSError as exc:
            print("[截屏失败]", exc)
            return None


def main():
    parser = server.build_arg_parser()
    parser.add_argument("--smoke-test", action="store_true", help="检查打包后的 WebKit 窗口")
    args = parser.parse_args()
    if not args.data_dir:
        args.data_dir = str(Path.home() / "Library" / "Application Support" / "JinChuan")
    data = Path(args.data_dir).expanduser().resolve()
    data.mkdir(parents=True, exist_ok=True)

    with (data / "lanbridge.log").open("a", buffering=1, encoding="utf-8") as log:
        sys.stdout = sys.stderr = log
        try:
            httpd, port = server.boot(args)
        except server.ListenError as exc:
            print(exc)
            if not args.smoke_test:
                alert = NSAlert.alloc().init()
                alert.setMessageText_("近传启动失败")
                alert.setInformativeText_(str(exc))
                alert.runModal()
            return 1

        bridge = server.DESKTOP = MacBridge(args)
        smoke = []
        try:
            webview.settings["ALLOW_DOWNLOADS"] = True
            window = webview.create_window(
                f"{server.APP_NAME} - {server.CONFIG.get('name', '')}",
                f"http://127.0.0.1:{port}/", width=1000, height=660, min_size=(780, 540))
            bridge.main = window
            bridge.main_visible = True
            if args.smoke_test:
                def check_webkit():
                    try:
                        smoke.append(window.evaluate_js("Boolean(document.getElementById('btnSend'))") is True)
                    finally:
                        window.destroy()
                window.events.loaded += check_webkit

            webview.start(gui="cocoa")
            if args.smoke_test and smoke != [True]:
                print("[check] WebKit did not load the bundled chat UI")
                return 1
        finally:
            httpd.shutdown()
            httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
