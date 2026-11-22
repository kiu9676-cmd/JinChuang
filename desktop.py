#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
近传 桌面外壳（QQ 式体验）
================================
  * pywebview 主窗口      —— 关闭窗口 = 最小化到托盘
  * 系统托盘图标 + 菜单    —— 常驻托盘，消息免打扰开关
  * QQ 式消息弹窗          —— 右下角卡片式消息预览，点击回到聊天窗口
  * 消息免打扰             —— 全局开关 + 按好友单独免打扰
  * 原生对话框             —— 另存为 / 更换接收文件夹
  * 一键截屏              —— 全屏抓图，界面里框选区域后直接发送
  * 开机自启（--tray 静默启动）

缺少 pywebview / pystray / PIL 时自动退回浏览器模式，功能不受影响。
"""
import json
import os
import platform
import shutil
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server                                          # noqa: E402

HAVE_WEBVIEW = False
try:
    import webview
    HAVE_WEBVIEW = True
except Exception:
    pass

HAVE_TRAY = False
try:
    import pystray
    from PIL import Image, ImageDraw, ImageGrab
    HAVE_TRAY = True
except Exception:
    pass


def screen_size():
    """主屏分辨率（用于把悬浮窗 / 弹窗摆到右下角）。"""
    try:
        import ctypes
        u = ctypes.windll.user32
        try:
            u.SetProcessDPIAware()
        except Exception:
            pass
        return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
    except Exception:
        return 1280, 800


# ---------------------------------------------------------------------------
# Windows 标题栏跟随主题
#   pywebview 用的是系统原生标题栏，深色界面配白色标题条会非常割裂。
#   这里用 DWM 属性把标题栏刷成和界面同一套颜色（Win11 支持精确着色）。
# ---------------------------------------------------------------------------
TITLE_CHROME = {"dark": "#222535", "light": "#fdfdff"}
TITLE_TEXT = {"dark": "#eeeffa", "light": "#212334"}
_themed_state = None


def system_prefers_dark():
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        try:
            v, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        finally:
            winreg.CloseKey(key)
        return int(v) == 0
    except Exception:
        return False


def resolve_theme(cfg=None):
    """config.theme: light / dark / auto -> 实际使用的 'light' / 'dark'。"""
    cfg = cfg or server.CONFIG
    t = str(cfg.get("theme") or "auto")
    if t in ("light", "dark"):
        return t
    return "dark" if system_prefers_dark() else "light"


def window_bg(theme):
    return "#181b28" if theme == "dark" else "#f6f7fb"


def _colorref(hex_color):
    h = str(hex_color).lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r | (g << 8) | (b << 16)


def _app_windows():
    """枚举本进程里标题以产品名开头的可见窗口（主窗 + 弹窗）。"""
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return []
    user32 = ctypes.windll.user32
    out = []
    pid = os.getpid()
    proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def each(hwnd, _):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            wpid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
            if wpid.value != pid:
                return True
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            if buf.value.startswith(server.APP_NAME):
                out.append(hwnd)
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(proto(each), 0)
    except Exception:
        pass
    return out


def apply_window_theme(cfg=None):
    """把 Windows 标题栏刷成当前主题色；非 Windows / 不支持时静默跳过。"""
    global _themed_state
    if platform.system() != "Windows":
        return False
    theme = resolve_theme(cfg)
    try:
        import ctypes
        dwm = ctypes.windll.dwmapi
    except Exception as e:
        print("[标题栏] 无法加载 dwmapi:", e)
        return False
    hwnds = _app_windows()
    if not hwnds:
        return False
    ok = False
    for hwnd in hwnds:
        try:
            flag = ctypes.c_int(1 if theme == "dark" else 0)
            for attr in (20, 19):          # DWMWA_USE_IMMERSIVE_DARK_MODE 新旧编号
                if dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(flag),
                                             ctypes.sizeof(flag)) == 0:
                    break
            cap = ctypes.c_uint(_colorref(TITLE_CHROME[theme]))
            txt = ctypes.c_uint(_colorref(TITLE_TEXT[theme]))
            dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(cap), ctypes.sizeof(cap))
            dwm.DwmSetWindowAttribute(hwnd, 36, ctypes.byref(txt), ctypes.sizeof(txt))
            ok = True
        except Exception:
            continue
    if ok and _themed_state != theme:
        _themed_state = theme
        print("[标题栏] 已切换为", theme)
    return ok


def msg_preview(msg):
    """消息卡片 / 气泡里显示的一句话。"""
    if msg.get("type") == "image":
        return "[图片]"
    if msg.get("type") == "file":
        return "[文件] {}".format(msg.get("fileName", ""))
    return str(msg.get("text", ""))[:80]


class DesktopBridge(object):
    """server.py 通过 HTTP 调用的桌面能力集合。"""

    def __init__(self, args, main_win=None, popup_win=None):
        self.args = args
        self.main = main_win
        self.popup = popup_win
        self.popup_lock = threading.Lock()
        self.icon = None
        self.focused = True          # 主窗口是否有焦点（前端 focus/blur 上报）
        self.main_visible = True     # pywebview 没有 shown 属性，自己记
        self.quitting = False
        self._popup_timer = None

    # ---------------- server 钩子 ----------------
    def on_message(self, peer_id, msg):
        """新入站消息：未读角标 + （未免打扰时）弹窗预览。"""
        total = sum(server.UNREAD.values())
        self._update_tray(total)
        with server.FILE_LOCK:
            p = server.PEERS.get(peer_id, {})
            name = p.get("alias") or p.get("name")
            if not name:
                g = server.GROUPS.get(peer_id) or {}
                name = g.get("name")
            name = name or "好友"
        # 免打扰：全局开关 或 该好友单独免打扰
        if server.CONFIG.get("dnd") or p.get("mute"):
            return
        main_hidden = self.main is None or not self.main_visible
        if main_hidden or not self.focused:
            self.show_popup(name, msg_preview(msg))

    def on_unread(self):
        self._update_tray(sum(server.UNREAD.values()))

    def on_settings(self, cfg):
        self._update_tray(sum(server.UNREAD.values()))
        # 改完昵称，窗口标题也跟着变，别还挂着旧名字
        try:
            if self.main is not None:
                self.main.set_title("{} - {}".format(server.APP_NAME, cfg.get("name", "")))
        except Exception:
            pass
        # 主题切换后同步原生标题栏，否则深色界面顶着一条白条
        try:
            apply_window_theme(cfg)
        except Exception:
            pass
        try:
            server.refresh()          # 让界面立刻拿到新的 config（主题/免打扰等）
        except Exception:
            pass

    def _update_tray(self, total):
        if self.icon:
            try:
                self.icon.title = server.APP_NAME + (
                    "（{} 条未读）".format(total) if total else "")
            except Exception:
                pass

    # ---------------- QQ 式消息弹窗 ----------------
    def show_popup(self, name, text):
        """右下角弹出消息卡片，5 秒自动收起；点击即回到聊天窗口。"""
        if self.popup is None:
            self.notify(name, text)
            return
        try:
            with self.popup_lock:
                self.popup.show()
            if self._popup_timer:
                self._popup_timer.cancel()
            self._popup_timer = threading.Timer(5.0, self._hide_popup)
            self._popup_timer.daemon = True
            self._popup_timer.start()
        except Exception as e:
            print("[消息弹窗失败]", e)
            self.notify(name, text)

    def _hide_popup(self):
        try:
            if self.popup:
                self.popup.hide()
        except Exception:
            pass

    def _url(self):
        return "http://127.0.0.1:{}/".format(int(server.CONFIG["http_port"]))

    # ---------------- 托盘气泡 ----------------
    def notify(self, title, message):
        if not self.icon:
            return
        try:
            self.icon.notify(title=str(title)[:30], message=str(message)[:120])
        except Exception:
            pass

    # ---------------- 桌面能力（HTTP /api/* 调用） ----------------
    def screenshot(self):
        """全屏抓图，保存到缓存目录，返回相对路径（给前端框选）。"""
        if not HAVE_TRAY:
            return None
        try:
            try:
                img = ImageGrab.grab(all_screens=True)
            except TypeError:
                img = ImageGrab.grab()
            f = server.CACHE_DIR / ("screenshot_{}.png".format(int(time.time() * 1000)))
            f.parent.mkdir(parents=True, exist_ok=True)
            img.save(f)
            return str(f.relative_to(server.DATA_DIR)).replace("\\", "/")
        except Exception as e:
            print("[截屏失败]", e)
            return None

    def choose_save_path(self, name):
        if self.main is None:
            return None
        result = self.main.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=str(name),
            file_types=("所有文件 (*.*)",))
        if isinstance(result, tuple):
            result = result[0] if result else None
        return result if isinstance(result, str) and result else None

    def save_as(self, rel, default_name):
        """原生另存为：把已收到的文件复制到用户选择的位置。"""
        try:
            src = server.resolve_media_path(rel or "")
            if src is None or not src.is_file():
                return None
            if self.main is None:
                return None
            result = self.main.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=str(default_name or src.name),
                file_types=("所有文件 (*.*)",))
            # SAVE_DIALOG 返回路径字符串；取消时返回空/None/空元组
            if isinstance(result, tuple):
                result = result[0] if result else None
            if not result or not isinstance(result, str):
                return None
            shutil.copy2(src, result)
            return result
        except Exception as e:
            print("[另存为失败]", e)
            return None

    def choose_folder(self):
        """原生目录选择：更换接收文件夹。"""
        try:
            if self.main is None:
                return None
            result = self.main.create_file_dialog(webview.FOLDER_DIALOG)
            if isinstance(result, tuple):
                return result[0] if result else None
            return result
        except Exception as e:
            print("[选择目录失败]", e)
            return None

    def control(self, action, value=None):
        """窗口控制：minimize/hide/show/ball/focus/quit。"""
        try:
            if action == "minimize" and self.main:
                self.main.minimize()
            elif action == "hide" and self.main:
                self.main.hide()
                self.main_visible = False
            elif action == "show" and self.main:
                self.main.show()
                self.main_visible = True
                self._hide_popup()
                if value:
                    # 点击消息弹窗 → 直接打开对应会话
                    try:
                        self.main.evaluate_js("selectPeer && selectPeer(%s)"
                                              % json.dumps(str(value)))
                    except Exception:
                        pass
            elif action == "focus":
                self.focused = bool(value)
            elif action == "popup_hide":
                self._hide_popup()
            elif action == "quit":
                self.quit_app()
        except Exception as e:
            print("[窗口控制失败]", action, e)

    def quit_app(self):
        self.quitting = True
        try:
            if self.icon:
                self.icon.stop()
        except Exception:
            pass
        for w in list(webview.windows):
            try:
                w.destroy()
            except Exception:
                pass
        # 给 webview 一点时间收尾
        threading.Timer(0.6, lambda: os._exit(0)).start()


def make_tray_icon(color="#5B8FF9", text="LB"):
    """优先用 assets/icon.png，缺失时退回手绘图标。"""
    try:
        base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
        f = base / "assets" / "icon.png"
        if f.is_file():
            return Image.open(f).convert("RGBA").resize((64, 64), Image.LANCZOS)
    except Exception:
        pass
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, 62, 62], radius=16, fill=color)
    try:
        w = d.textlength(text)
    except Exception:
        w = len(text) * 10
    d.text(((64 - w) / 2, 64 / 2 - 12), text, fill="white")
    return img


def setup_log():
    """打包成无控制台 exe 后，把 stdout/stderr 落到 data/lanbridge.log。"""
    if not getattr(sys, "frozen", False):
        return
    try:
        logdir = Path(sys.executable).resolve().parent / "data"
        logdir.mkdir(parents=True, exist_ok=True)
        f = open(logdir / "lanbridge.log", "a", buffering=1, encoding="utf-8")
        f.write("\n===== {} =====\n".format(time.strftime("%Y-%m-%d %H:%M:%S")))
        sys.stdout = f
        sys.stderr = f
    except Exception:
        pass


def main():
    setup_log()
    args = server.build_arg_parser().parse_args()
    try:
        httpd, port = server.boot(args)
    except server.ListenError as e:
        print("[启动失败]", e)
        if sys.platform == "win32" and not args.tray and not args.no_browser:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, str(e), "近传 v" + server.VERSION, 0x30)
        raise SystemExit(1) from e
    server.DESKTOP = DesktopBridge(args)
    url = "http://127.0.0.1:{}/".format(port)

    if not HAVE_WEBVIEW:
        # ---------- 浏览器模式（macOS / 无依赖环境） ----------
        print("[桌面外壳不可用] 缺少 pywebview，退回浏览器模式")
        if not args.no_browser:
            webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    # ---------- 托盘 ----------
    icon = None
    if HAVE_TRAY:
        def tray_show(icon_item):
            server.DESKTOP.control("show")

        def tray_folder(icon_item):
            server.open_in_explorer(server.DOWNLOAD_DIR)

        def tray_dnd(icon_item):
            """全局消息免打扰开关。"""
            server.CONFIG["dnd"] = not server.CONFIG.get("dnd", False)
            server.save_json(server.CONFIG_FILE, server.CONFIG)
            server.refresh()          # 让设置面板 / 角标同步，不然界面还是旧状态
            server.DESKTOP.notify(server.APP_NAME,
                                  "免打扰已开启" if server.CONFIG["dnd"] else "免打扰已关闭")

        def tray_quit(icon_item):
            server.DESKTOP.quit_app()

        menu = pystray.Menu(
            pystray.MenuItem("打开聊天窗口", tray_show, default=True),
            pystray.MenuItem("接收文件夹", tray_folder),
            pystray.MenuItem("消息免打扰", tray_dnd,
                             checked=lambda item: bool(server.CONFIG.get("dnd", False))),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", tray_quit),
        )
        icon = pystray.Icon(
            "JinChuan",
            icon=make_tray_icon(),
            title=server.APP_NAME,
            menu=menu)
        server.DESKTOP.icon = icon
        threading.Thread(target=icon.run, daemon=True).start()
    else:
        print("[托盘不可用] 缺少 pystray / PIL")

    # ---------- 主窗口 + 悬浮窗 ----------
    sw, sh = screen_size()
    # 消息弹窗：启动即建好（隐藏），避免运行时建窗失败
    popup_win = None
    if HAVE_TRAY:
        try:
            popup_win = webview.create_window(
                server.APP_NAME + " 消息", url + "popup.html", width=330, height=104,
                x=max(sw - 350, 0), y=max(sh - 170, 0),
                frameless=True, on_top=True, hidden=True, easy_drag=False,
                background_color=window_bg(resolve_theme()))
        except Exception as e:
            print("[消息弹窗创建失败]", e)

    main_win = webview.create_window(
        "{} - {}".format(server.APP_NAME, server.CONFIG.get("name", "")),
        url, width=1000, height=660, min_size=(780, 540),
        hidden=bool(args.tray),
        background_color=window_bg(resolve_theme()))

    server.DESKTOP.main = main_win
    server.DESKTOP.popup = popup_win
    server.DESKTOP.main_visible = not bool(args.tray)

    # 关闭主窗口 = 隐藏到托盘（QQ 式）
    def on_closing():
        if server.CONFIG.get("close_to_tray", True):
            main_win.hide()
            server.DESKTOP.main_visible = False
            return False
        server.DESKTOP.quit_app()
        return False
    main_win.events.closing += on_closing

    # 用 pywebview 自己报的逻辑分辨率重新摆位（避免高 DPI 下窗口跑到屏幕外）
    def place_windows():
        w = h = 0
        for _ in range(40):
            try:
                scr = webview.screens[0]
                w, h = int(scr.width), int(scr.height)
                if w > 200 and h > 200:
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if w <= 200:
            return
        try:
            if popup_win:
                popup_win.move(max(w - 352, 0), max(h - 176, 0))
                # hidden=True 在部分 WebView2 版本上不生效，这里强制收起并预载内容
                popup_win.hide()
                try:
                    popup_win.load_url(url + "popup.html")
                except Exception:
                    pass
                time.sleep(0.2)
                popup_win.hide()
        except Exception as e:
            print("[窗口定位失败]", e)
    threading.Thread(target=place_windows, daemon=True).start()

    # 窗口真正出现后再刷一次标题栏颜色（刚 create 时 HWND 还没就绪）
    def init_window_theme():
        for _ in range(24):
            try:
                if apply_window_theme():
                    break
            except Exception:
                pass
            time.sleep(0.4)
        # 持续校正：theme=auto 跟随系统日夜切换，外部改了标题栏也能自动拉回
        while True:
            try:
                apply_window_theme()
            except Exception:
                pass
            time.sleep(4.0)
    threading.Thread(target=init_window_theme, daemon=True).start()

    print("  桌面窗口已启动（关闭窗口 = 最小化到托盘）")
    try:
        webview.start()
    except Exception as e:
        print("[桌面窗口启动失败，退回浏览器模式]", e)
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    # webview.start 返回（所有窗口关闭或退出）
    time.sleep(0.3)
    if not server.DESKTOP.quitting and server.CONFIG.get("close_to_tray", True):
        # 最后一个窗口被系统关闭（如任务栏关闭）→ 程序继续驻留托盘
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    os._exit(0)


if __name__ == "__main__":
    main()
