#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
近传 - 局域网好友聊天 + 文件/文件夹互传
=================================================
零第三方依赖，仅需 Python 3.8+。Windows / macOS / Linux 同一份代码，直接互通。

设计参考：
  * LocalSend Protocol v2  : UDP 组播发现 + HTTP 直传 + HTTP 注册兜底
  * PairDrop               : 设备即好友、可配对/持久化
  * 主流 IM                : 好友资料可编辑、会话气泡、未读、置顶

每个节点都是对等的：
  - UDP 组播宣告自己的存在（自动发现好友）
  - HTTP 服务提供：本地 Web UI、节点间消息、文件流接收
  - WebSocket 把「新消息 / 好友上下线 / 传输进度」实时推给本机界面
"""
import argparse
import errno
import base64
import hashlib
import json
import mimetypes
import os
import platform
import random
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
import http.client
import webbrowser
import mj
import ipaddress
from local_cache import LocalCache
from transfer_resume import MAX_CHUNK, DIGEST, ChunkStore, TransferError, read_record, write_record
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_NAME = "近传"
VERSION = "1.6.3"
BUILD_DATE = "2026-11-21"
WINDOWS_RELEASE_ASSET = "default.exe"
# 更新源：写死在这里（客户端界面不暴露、不可改）。
# 仓库：https://github.com/kiu9676-cmd/JinChuang
DEFAULT_UPDATE_REPO = "kiu9676-cmd/JinChuang"
DEFAULT_HTTP_PORT = 8765
DEFAULT_UDP_PORT = 53317          # 与 LocalSend 默认端口一致
MCAST_GRP = "224.0.0.167"        # 224.0.0.0/24，兼容性最好
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CHUNK = 64 * 1024
PEER_TIMEOUT = 9.0
ANNOUNCE_INTERVAL = 2.0
LEGACY_INTERVAL = 6.0

if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent
    WEB_DIR = Path(getattr(sys, "_MEIPASS", ROOT)) / "web"
else:
    ROOT = Path(__file__).resolve().parent
    WEB_DIR = ROOT / "web"

DATA_DIR = ROOT / "data"
DOWNLOAD_DIR = DATA_DIR / "downloads"
CACHE_DIR = DATA_DIR / "cache"
CONFIG_FILE = DATA_DIR / "config.json"
PEERS_FILE = DATA_DIR / "peers.json"
MESSAGES_FILE = DATA_DIR / "messages.json"

FILE_LOCK = threading.RLock()
WS_LOCK = threading.Lock()
WS_CLIENTS = set()
REFRESH_EVENT = threading.Event()

PEERS = {}        # peerId -> 好友资料（可编辑、可持久化）
MESSAGES = {}     # peerId -> [消息]
TRANSFERS = {}    # transferId -> 传输任务
CONFIG = {}
ME = {}
UNREAD = {}       # peerId -> 未读数（供托盘提示 / 标题角标）
RESUME_STORE = None
LOCAL_CACHE = None
OUTBOX = {}
OUTBOX_ACTIVE = set()
OUTBOX_LOCK = threading.RLock()
OUTBOX_SLOTS = threading.BoundedSemaphore(2)
DESKTOP = None    # 桌面外壳桥（desktop.py 注入：托盘/消息弹窗/原生对话框/截屏/通知）

AVATAR_KEYS = ("fox", "panda", "rabbit", "cat", "robot", "puppy")


def avatar_key(value, default="fox"):
    return value if isinstance(value, str) and value in AVATAR_KEYS else default



# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------
def now_ms():
    return int(time.time() * 1000)


def new_id(prefix=""):
    return prefix + hashlib.md5((str(time.time()) + str(os.getpid()) +
                                 str(threading.get_ident()) +
                                 str(now_ms())).encode()).hexdigest()[:12]


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        print("[warn] 保存 {} 失败: {}".format(path.name, e))


def human_size(n):
    n = float(n or 0)
    for u in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024 or u == "TB":
            return "{:.0f} {}".format(n, u) if u == "B" else "{:.1f} {}".format(n, u)
        n /= 1024


def safe_rel(rel):
    """清理相对路径，防目录穿越与 Windows 非法字符。"""
    rel = (rel or "").replace("\\", "/")
    parts = []
    for part in rel.split("/"):
        part = part.strip()
        if part in ("", ".", ".."):
            continue
        part = re.sub(r'[<>:"|?*\x00-\x1f]', "_", part).rstrip(". ")
        if part:
            parts.append(part)
    if not parts:
        parts = ["received_file"]
    return "/".join(parts)


def unique_path(path):
    path = Path(path)
    if not path.exists():
        return path
    i = 1
    while True:
        cand = path.with_name("{}({}){}".format(path.stem, i, path.suffix))
        if not cand.exists():
            return cand
        i += 1


def local_ips():
    ips = set()
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127."):
            ips.add(ip)
    except Exception:
        pass
    return list(ips) or ["127.0.0.1"]


def primary_ip():
    return local_ips()[0]


# ----------------------------------------------------------------------------
# 状态与持久化
# ----------------------------------------------------------------------------
def init_store(args):
    global DATA_DIR, DOWNLOAD_DIR, CACHE_DIR, CONFIG, ME, PEERS, MESSAGES
    global CONFIG_FILE, PEERS_FILE, MESSAGES_FILE, GROUPS_FILE, RESUME_STORE, LOCAL_CACHE

    if args.data_dir:
        DATA_DIR = Path(args.data_dir).resolve()
    RESUME_STORE = ChunkStore(DATA_DIR, lambda: DOWNLOAD_DIR, unique_path)
    CACHE_DIR = DATA_DIR / "cache"
    LOCAL_CACHE = LocalCache(CACHE_DIR, unique_path, FILE_LOCK)
    CONFIG_FILE = DATA_DIR / "config.json"
    PEERS_FILE = DATA_DIR / "peers.json"
    MESSAGES_FILE = DATA_DIR / "messages.json"
    GROUPS_FILE = DATA_DIR / "groups.json"

    defaults = {
        "node_id": new_id("n-"),
        "name": "{} 的电脑".format(platform.node() or "我")[:24],
        "avatar_key": "fox",
        "http_port": DEFAULT_HTTP_PORT,
        "udp_port": DEFAULT_UDP_PORT,
        "download_dir": "",              # 空 = data/downloads；可自定义接收目录
        "dnd": False,                    # 消息免打扰（全局）
        "sound": True,                   # 新消息提示音
        "theme": "auto",                 # 外观：light / dark / auto
        "motion": "full",                # 动效：full / reduced（眼睛累时用精简）
        "close_to_tray": True,           # 关闭主窗口 = 最小化到托盘
        "autostart": False,              # 开机自启（仅 exe / Windows）
        # 在线更新：GitHub 仓库 owner/repo（留空 = 不检查更新）
        "update_repo": "",
        "update_api": "https://api.github.com",
        # 「通过代码添加好友」：直接在这里写对方 IP 或 IP:端口
        "manual_peers": []
    }
    CONFIG = load_json(CONFIG_FILE, {})
    for k, v in defaults.items():
        CONFIG.setdefault(k, v)
    # 兼容旧版把头像写到的大驼峰键（旧 /api/settings 的 bug，重启后头像会丢）
    for legacy, real in (("avatarText", "avatar_text"), ("avatarColor", "avatar_color")):
        if CONFIG.get(legacy):
            CONFIG[real] = CONFIG.pop(legacy)

    if args.http_port:
        CONFIG["http_port"] = args.http_port
    if args.udp_port:
        CONFIG["udp_port"] = args.udp_port
    if args.name:
        CONFIG["name"] = args.name
    CONFIG["avatar_key"] = avatar_key(CONFIG.get("avatar_key"))
    save_json(CONFIG_FILE, CONFIG)

    # 接收目录：优先用用户在设置里选的目录
    if CONFIG.get("download_dir"):
        DOWNLOAD_DIR = Path(CONFIG["download_dir"]).resolve()
    else:
        DOWNLOAD_DIR = DATA_DIR / "downloads"
    for d in (DATA_DIR, DOWNLOAD_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)

    PEERS = load_json(PEERS_FILE, {}).get("peers", {})
    MESSAGES = load_json(MESSAGES_FILE, {})
    load_groups()
    for pid, p in PEERS.items():
        p["online"] = False
        p.setdefault("manual", False)

    ME = {
        "id": CONFIG["node_id"],
        "name": CONFIG["name"],
        "avatarKey": CONFIG["avatar_key"],
        "ip": primary_ip(),
        "http": int(CONFIG["http_port"]),
        "udp": int(CONFIG["udp_port"]),
        "platform": platform.system(),
        "app": APP_NAME,
        "v": VERSION, "resume": True, "transferControl": True
    }


    load_outbox()
    restore_inbox_progress()

def my_announce(reply=False):
    d = dict(ME)
    d["type"] = "announce"
    d["ts"] = now_ms()
    d["reply"] = bool(reply)
    return d


def save_peers():
    save_json(PEERS_FILE, {"peers": PEERS})


def save_messages():
    save_json(MESSAGES_FILE, MESSAGES)


def apply_profile_fields(d):
    """更新本机对外资料；已有旧配置字段保留，但不参与新头像渲染。"""
    old = (ME.get("name"), ME.get("avatarKey"))
    if "name" in d:
        CONFIG["name"] = ME["name"] = str(d["name"]).strip()[:24] or CONFIG["name"]
    if d.get("avatarKey") in AVATAR_KEYS:
        CONFIG["avatar_key"] = ME["avatarKey"] = d["avatarKey"]
    return old != (ME.get("name"), ME.get("avatarKey"))


def announce_profile_to_peers():
    """修改后立即同步在线好友；离线好友下次发现时也会收到同一份资料。"""
    with FILE_LOCK:
        peers = [dict(p) for p in PEERS.values()
                 if time.time() - p.get("last_seen", 0) < PEER_TIMEOUT]
    for peer in peers:
        try:
            post_to(peer, "/api/register", my_announce(reply=True), timeout=2)
        except (OSError, http.client.HTTPException):
            continue


# ----------------------------------------------------------------------------
# 系统集成：打开目录 / 开机自启
# 说明：这两个函数在早期版本里被 /api/open-folder 与 /api/settings 调用，
#       但一直没有定义 —— 设置里的「打开」「开机自启」一按就 500（NameError）。
# ----------------------------------------------------------------------------
AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "JinChuan"


def open_in_explorer(path):
    """在系统文件管理器里打开目录；给的是文件就定位到该文件。"""
    try:
        p = Path(str(path or "")).expanduser()
        if not p.is_absolute():
            p = (DATA_DIR / p)
        p = p.resolve()
        if not p.exists():
            return False
        is_file = p.is_file()
        if platform.system() == "Windows":
            if is_file:
                subprocess.Popen(["explorer", "/select,", str(p)])
            else:
                os.startfile(str(p))                      # noqa: S606
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", "-R", str(p)] if is_file else ["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p if p.is_dir() else p.parent)])
        return True
    except Exception as e:
        print("[打开目录失败]", path, e)
        return False


def autostart_command():
    """开机自启要执行的命令：exe 直接 --tray，源码运行走 desktop.py --tray。"""
    if getattr(sys, "frozen", False):
        return '"{}" --tray'.format(Path(sys.executable).resolve())
    script = Path(__file__).resolve().parent / "desktop.py"
    if script.is_file():
        return '"{}" "{}" --tray'.format(sys.executable, script)
    return ""


def set_autostart(enable):
    """写入 / 删除 HKCU\\...\\Run 项。返回 (ok, message)。"""
    if platform.system() != "Windows":
        return True, "非 Windows，系统自带自启管理"
    cmd = autostart_command()
    if enable and not cmd:
        return False, "找不到可自启的入口（缺少 desktop.py）"
    try:
        import winreg
    except Exception as e:
        return False, "无法访问注册表: {}".format(e)
    try:
        key = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0,
                                 winreg.KEY_SET_VALUE)
        try:
            if enable:
                winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, cmd)
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
        finally:
            winreg.CloseKey(key)
        return True, "ok"
    except Exception as e:
        return False, "写入注册表失败: {}".format(e)


# ----------------------------------------------------------------------------
# 在线更新（GitHub Releases）
#   GET  /api/update/check           查最新 Release（5 分钟缓存，可 force 刷新）
#   POST /api/update/download        后台下载新 exe
#   GET  /api/update/status          下载进度
#   POST /api/update/apply           退出本进程 → 脚本替换 exe → 自动重启
#
# 发版流程见 README「发布新版本」：改版本号 → release.py → GitHub 建 Release
# 并把 exe 作为 asset 传上去，客户端就能一键更新。
# ----------------------------------------------------------------------------
try:
    for _f in (DATA_DIR / "update").glob("*.part"):
        _f.unlink()
except Exception:
    pass

UPDATE_LOCK = threading.Lock()
UPDATE = {"state": "idle", "percent": 0, "bytes": 0, "total": 0,
          "path": "", "name": "", "error": "", "version": ""}
UPDATE_CACHE = (0.0, None)          # (时间戳, 检查结果)


def parse_version(text):
    """把 v1.2.3 / 1.2.3-beta 变成 (1, 2, 3) 便于比较。"""
    nums = re.findall(r"\d+", str(text or ""))
    return tuple(int(x) for x in nums[:3]) or (0,)


def update_repo():
    """更新源仓库：优先 config/环境变量（方便本地测试），否则用代码里写死的。"""
    v = (CONFIG.get("update_repo") or os.environ.get("JINCHUAN_REPO") or "").strip()
    return (v or DEFAULT_UPDATE_REPO).strip("/")


def update_api_base():
    return str(CONFIG.get("update_api") or "https://api.github.com").rstrip("/")



class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def latest_tag_via_redirect(repo):
    """不走 GitHub API：请求 /releases/latest，从 302 的 Location 里取 tag。

    API 匿名限流 60 次/小时（同一出口 IP 很容易打满），这条路不限额。
    """
    url = "https://github.com/{}/releases/latest".format(repo)
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": "JinChuan/{}".format(VERSION)})
    try:
        opener.open(req, timeout=8)
        return None                      # 没跳转说明没有 Release
    except urllib.error.HTTPError as e:
        loc = (e.headers.get("Location") or "") if e.headers else ""
        if "/releases/tag/" in loc:
            return loc.rsplit("/releases/tag/", 1)[1].split("?")[0].strip("/")
        return None
    except Exception:
        return None


def fallback_release_info(repo):
    """API 不可用时，用跳转 + 约定的资产名拼出最小可用信息。"""
    tag = latest_tag_via_redirect(repo)
    if not tag:
        return None
    asset_url = "https://github.com/{}/releases/download/{}/{}".format(
        repo, tag, urllib.parse.quote(WINDOWS_RELEASE_ASSET))
    return {
        "ok": True, "repo": repo, "tag": tag, "latest": tag.lstrip("vV"),
        "notes": "", "publishedAt": "", "fallback": True,
        "htmlUrl": "https://github.com/{}/releases/tag/{}".format(repo, tag),
        "asset": {"name": WINDOWS_RELEASE_ASSET, "size": 0, "url": asset_url},
        "current": VERSION,
        "hasUpdate": parse_version(tag) > parse_version(VERSION),
    }


def fetch_latest_release():
    """读 GitHub 最新 Release；返回统一结构，永远不抛异常。"""
    repo = update_repo()
    if not repo:
        return {"ok": False, "error": "还没设置更新源仓库（设置 → 更新 → 仓库 owner/repo）"}
    url = "{}/repos/{}/releases/latest".format(update_api_base(), repo)
    req = urllib.request.Request(url, headers={
        "User-Agent": "JinChuan/{}".format(VERSION),
        "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ok": False, "repo": repo,
                    "error": "仓库 {} 里还没有发布过版本（发第一个 Release 后就能检查更新）".format(repo)}
        if e.code in (401, 403):
            # 匿名 API 限流很常见：改用 releases/latest 的 302 拿 tag
            info = fallback_release_info(repo)
            if info:
                return info
            return {"ok": False, "repo": repo,
                    "error": "GitHub 拒绝访问（{}）：接口被限流，稍后再试".format(e.code)}
        return {"ok": False, "repo": repo, "error": "检查更新失败：HTTP {}".format(e.code)}
    except Exception as e:
        return {"ok": False, "repo": repo,
                "error": "连不上更新服务器：{}".format(e)}

    tag = str(data.get("tag_name") or data.get("name") or "")
    latest = tag.lstrip("vV") or str(data.get("name") or "")
    asset = None
    for a in data.get("assets") or []:
        name = str(a.get("name") or "")
        if name.lower().endswith(".exe"):
            asset = {"name": name, "size": int(a.get("size") or 0),
                     "url": a.get("browser_download_url") or ""}
            break
    return {
        "ok": True, "repo": repo, "tag": tag, "latest": latest,
        "notes": str(data.get("body") or "")[:8000],
        "publishedAt": data.get("published_at") or "",
        "htmlUrl": data.get("html_url") or "",
        "asset": asset,
        "current": VERSION,
        "hasUpdate": parse_version(latest) > parse_version(VERSION),
    }


def check_update(force=False):
    """带缓存地检查更新（GitHub 匿名限流 60 次/小时，别每次开面板都打）。"""
    global UPDATE_CACHE
    now = time.time()
    ts, info = UPDATE_CACHE
    if info and not force and now - ts < 300:
        return dict(info)
    info = fetch_latest_release()
    if info.get("ok"):
        info["current"] = VERSION
        info["hasUpdate"] = parse_version(info.get("latest")) > parse_version(VERSION)
    info["checked"] = int(now)
    UPDATE_CACHE = (now, info)
    return dict(info)


UPDATE_CANCEL = {"flag": False}


def update_download_live():
    """当前是否真的在下载（30 秒没有任何进展就算僵尸任务）。"""
    if UPDATE.get("state") != "downloading":
        return False
    return (time.time() - float(UPDATE.get("ts") or 0)) < 30


def cancel_update_download():
    UPDATE_CANCEL["flag"] = True
    with UPDATE_LOCK:
        was = UPDATE.get("state") == "downloading"
        UPDATE.update({"state": "idle", "percent": 0, "bytes": 0, "total": 0,
                       "error": "", "path": "", "ts": time.time()})
    try:
        for f in (DATA_DIR / "update").glob("*.part"):
            f.unlink()
    except Exception:
        pass
    return was


def start_update_download(url, name, size):
    """返回 (是否成功, 是否已经在跑，即 attached)。"""
    with UPDATE_LOCK:
        if update_download_live():
            return True, True                      # 已经在下载：让前端接上看进度
        UPDATE_CANCEL["flag"] = False
        UPDATE.update({"state": "downloading", "percent": 0, "bytes": 0,
                       "total": int(size or 0), "error": "", "path": "",
                       "name": name, "version": "", "ts": time.time()})
    threading.Thread(target=_update_download_worker, args=(url, name, size),
                     daemon=True).start()
    return True, False


def _update_download_worker(url, name, size):
    dest_dir = DATA_DIR / "update"
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^\w.\-\u4e00-\u9fa5]", "_", name or "")[-80:] or "JinChuan.exe"
    tmp = dest_dir / (safe + ".part")
    dest = dest_dir / safe
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "JinChuan/" + VERSION})
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length") or size or 0)
            got = 0
            while True:
                chunk = r.read(262144)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if UPDATE_CANCEL["flag"]:
                    raise RuntimeError("已取消")
                with UPDATE_LOCK:
                    UPDATE["bytes"] = got
                    UPDATE["total"] = total or got
                    UPDATE["percent"] = min(99, int(got * 100 / (total or got or 1)))
                    UPDATE["ts"] = time.time()
        if got < 65536:
            raise RuntimeError("下载内容太小（{} 字节），可能不是安装包".format(got))
        with open(tmp, "rb") as f:
            if f.read(2) != b"MZ":
                raise RuntimeError("下载到的不是 Windows 可执行文件")
        os.replace(tmp, dest)
        with UPDATE_LOCK:
            UPDATE.update({"state": "ready", "path": str(dest), "percent": 100,
                           "bytes": got, "total": got})
    except Exception as e:
        if str(e) == "已取消":
            with UPDATE_LOCK:
                UPDATE.update({"state": "idle", "error": "", "percent": 0,
                               "bytes": 0, "total": 0, "path": ""})
        else:
            with UPDATE_LOCK:
                UPDATE.update({"state": "error", "error": str(e), "ts": time.time()})
        try:
            tmp.unlink()
        except Exception:
            pass


UPDATE_PS1 = """param([int]$TargetPid, [string]$Src, [string]$Dst)
$ErrorActionPreference = 'SilentlyContinue'
# 等旧进程退出（最多 60 秒）
for ($i = 0; $i -lt 120; $i++) {{
  if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {{ break }}
  Start-Sleep -Milliseconds 500
}}
Start-Sleep -Milliseconds 600
# exe 可能还被占用，重试替换
$ok = $false
for ($i = 0; $i -lt 40; $i++) {{
  try {{
    Copy-Item -LiteralPath $Src -Destination $Dst -Force -ErrorAction Stop
    $ok = $true
    break
  }} catch {{ Start-Sleep -Milliseconds 500 }}
}}
if ($ok) {{
  Start-Process -FilePath $Dst
  Remove-Item -LiteralPath $Src -Force
}} else {{
  # 换不下来就退回到直接运行新文件，至少让用户用上
  Start-Process -FilePath $Src
}}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force
"""


def apply_update(dry_run=False):
    """把已下载的新 exe 换上去并重启。返回 (ok, message, script_path)。"""
    with UPDATE_LOCK:
        state, src = UPDATE["state"], UPDATE["path"]
    if state != "ready" or not src or not Path(src).is_file():
        return False, "还没有下载好的更新包", ""
    frozen = bool(getattr(sys, "frozen", False))
    dst = str(Path(sys.executable).resolve()) if frozen else str(Path(src))
    script = DATA_DIR / "update" / "apply_update.ps1"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(UPDATE_PS1.format(), encoding="utf-8-sig")
    if dry_run:
        return True, "dry-run", str(script)
    if not frozen:
        return False, "源码模式不支持自替换，请 git pull 后重启", str(script)
    if platform.system() != "Windows":
        return False, "当前系统请手动替换 exe", str(script)
    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-WindowStyle", "Hidden", "-File", str(script),
             "-TargetPid", str(os.getpid()), "-Src", str(src), "-Dst", dst],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:
        return False, "启动更新脚本失败：{}".format(e), str(script)
    return True, "正在重启…", str(script)


def refresh():
    """合并刷新信号，避免组播风暴导致前端反复拉全量。"""
    REFRESH_EVENT.set()


def refresher_loop():
    while True:
        REFRESH_EVENT.wait()
        time.sleep(0.25)
        REFRESH_EVENT.clear()
        broadcast({"type": "refresh"})


def broadcast(obj):
    with WS_LOCK:
        clients = list(WS_CLIENTS)
    for c in clients:
        c.send(obj)


def push_progress(task):
    broadcast({"type": "progress", "task": dict(task)})


def peer_view(p):
    d = dict(p)
    d["online"] = bool(time.time() - p.get("last_seen", 0) < PEER_TIMEOUT)
    d["displayName"] = p.get("alias") or p.get("name") or p.get("id", "?")
    return d


def sorted_peers():
    arr = [peer_view(p) for p in PEERS.values()]
    arr.sort(key=lambda x: (not x.get("pinned", False), not x["online"],
                            x["displayName"].lower()))
    return arr


def sorted_groups():
    arr = [group_view(g) for g in GROUPS.values()]
    arr.sort(key=lambda x: x.get("updatedAt") or x.get("createdAt") or 0, reverse=True)
    return arr


def state_snapshot():
    with FILE_LOCK:
        return {
            "ok": True,
            "app": APP_NAME,
            "version": VERSION,
            "build": BUILD_DATE,
            "frozen": bool(getattr(sys, "frozen", False)),
            "updateRepo": update_repo(),
            "me": dict(ME),
            "config": dict(CONFIG),
            "platform": platform.system(),
            "dataDir": str(DATA_DIR),
            "downloadDir": str(DOWNLOAD_DIR),
            "unread": dict(UNREAD),
            "desktop": bool(DESKTOP),
            "peers": sorted_peers(),
            "groups": sorted_groups(),
            "messages": {k: list(v) for k, v in MESSAGES.items()},
            "transfers": [dict(t) for t in TRANSFERS.values()]
        }


# ----------------------------------------------------------------------------
# 好友：发现 / 注册 / 编辑
# ----------------------------------------------------------------------------
def new_peer(pid, info, ip, manual=False):
    return {
        "id": pid,
        "name": info.get("name", "未命名"),
        "alias": "",                       # 备注名（可编辑）
        "avatarKey": avatar_key(info.get("avatarKey")),
        "resume": info.get("resume") is True,
        "transferControl": info.get("transferControl") is True,
        "group": "",                       # 分组（可编辑）
        "note": "",                        # 备注（可编辑）
        "pinned": False,
        "manual": manual,
        "ip": ip or info.get("ip", "127.0.0.1"),
        "http": int(info.get("http", DEFAULT_HTTP_PORT)),
        "platform": info.get("platform", ""),
        "last_seen": time.time()
    }


def update_peer(info, source_ip, manual=False):
    pid = info.get("id")
    if not pid or pid == ME["id"] or info.get("app") != APP_NAME:
        return None
    ip = source_ip if not str(source_ip).startswith("127.") else (info.get("ip") or source_ip)
    changed = False
    with FILE_LOCK:
        p = PEERS.get(pid)
        if p is None:
            p = new_peer(pid, info, ip, manual)
            PEERS[pid] = p
            changed = True
        else:
            for k, v in (("name", info.get("name")), ("avatarKey", avatar_key(info.get("avatarKey"), None)), ("ip", ip),
                         ("http", int(info.get("http", p["http"]))),
                         ("platform", info.get("platform", p["platform"]))):
                if v and p.get(k) != v:
                    p[k] = v
                    changed = True
        supports_resume = info.get("resume") is True
        if p.get("resume", False) != supports_resume:
            p["resume"] = supports_resume
            changed = True
        if p.get("transferControl", False) != (info.get("transferControl") is True):
            p["transferControl"] = info.get("transferControl") is True
            changed = True
        was_online = time.time() - p.get("last_seen", 0) < PEER_TIMEOUT
        p["last_seen"] = time.time()
        if manual:
            p["manual"] = True
        save_peers()
    if changed or not was_online:
        refresh()
    return PEERS.get(pid)


def expire_peers():
    changed = False
    with FILE_LOCK:
        for p in PEERS.values():
            if time.time() - p.get("last_seen", 0) >= PEER_TIMEOUT:
                if p.get("_was_online", True):
                    p["_was_online"] = False
                    changed = True
            else:
                p["_was_online"] = True
        now = time.monotonic()
        for task in TRANSFERS.values():
            if task.get("direction") == "in" and task.get("status") == "running" and now - task.get("lastActivity", now) > 30:
                task.update(status="waiting", speed=0, error="暂未收到下一段数据，等待对方继续。")
                changed = True
    if changed:
        refresh()


def post_to(peer, path, obj, timeout=4):
    conn = http.client.HTTPConnection(peer["ip"], int(peer["http"]), timeout=timeout)
    try:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        conn.request("POST", path, body=body,
                     headers={"Content-Type": "application/json; charset=utf-8"})
        r = conn.getresponse()
        data = r.read()
        try:
            return r.status, json.loads(data.decode("utf-8"))
        except Exception:
            return r.status, {}
    finally:
        conn.close()


def resolve_media_path(ref):
    if not isinstance(ref, str) or not ref:
        return None
    ref = ref.replace("\\", "/")
    if ref.startswith("received/"):
        return RESUME_STORE.media_path(ref)
    if ref.startswith("legacy-received/"):
        parts = ref.split("/")
        if len(parts) != 3 or not DIGEST.fullmatch(parts[1]):
            return None
        record = read_record(DATA_DIR / "received-refs" / (parts[1] + ".json"))
        if not record:
            return None
        target = Path(record["path"])
        return target if target.name == parts[2] else None
    target = (DATA_DIR / safe_rel(ref)).resolve()
    return target if DATA_DIR in target.parents else None


def received_reference(path):
    path = path.resolve()
    if DATA_DIR in path.parents:
        return path.relative_to(DATA_DIR).as_posix()
    key = hashlib.sha256(os.fsencode(path)).hexdigest()
    write_record(DATA_DIR / "received-refs" / (key + ".json"), {"path": str(path)})
    return "legacy-received/" + key + "/" + path.name


def diagnose_peer(d):
    local = {"ip": ME["ip"], "http": ME["http"], "version": VERSION}

    def result(code, message, **detail):
        return dict(ok=code == "online", code=code, message=message, local=local, **detail)

    pid = d.get("id")
    with FILE_LOCK:
        peer = dict(PEERS.get(pid, {})) if isinstance(pid, str) else {}
    if pid and not peer:
        return result("unknown", "设备已不在好友列表，请重新添加。")
    raw = str(d.get("address") or "").strip().removeprefix("http://").rstrip("/")
    host, _, port = raw.partition(":")
    try:
        ip = ipaddress.IPv4Address(peer.get("ip", host))
        port = int(peer.get("http", port or DEFAULT_HTTP_PORT))
        if not any(ip in ipaddress.IPv4Network(net) for net in (
                "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
                "100.64.0.0/10", "127.0.0.0/8")) or not 1 <= port <= 65535:
            raise ValueError()
    except (TypeError, ValueError):
        return result("invalid", "请输入局域网 IPv4 地址，可加端口，例如 192.168.1.12:8765。")
    address = f"{ip}:{port}"
    detail = {"address": address, "lastSeen": int((peer.get("last_seen") or 0) * 1000)}
    start = time.monotonic()
    conn = http.client.HTTPConnection(str(ip), port, timeout=2.5)
    try:
        conn.request("GET", "/api/ping")
        response = conn.getresponse()
        if response.status != 200:
            return result("other_service", f"端口有响应，但没有返回近传设备信息（HTTP {response.status}）。", **detail)
        data = json.loads(response.read(8192))
        if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("id"), str) or not data.get("version"):
            return result("other_service", "端口有响应，但没有返回近传设备信息。", **detail)
        if data["id"] == ME["id"]:
            return result("self", "这个地址指向本机，请填对方的设备地址。", **detail)
        if pid and pid != data["id"]:
            return result("wrong_device", "这个地址响应的是另一台近传设备，请核对对方的新地址。", **detail)
        return result("online", "对方的近传已响应，可以建立连接。", **detail,
                      name=str(data.get("name", "")), version=str(data["version"]),
                      latencyMs=round((time.monotonic() - start) * 1000), resume=data.get("resume") is True)
    except ConnectionRefusedError:
        return result("refused", "端口拒绝连接。请确认对方已打开近传，且端口填写正确。", **detail)
    except TimeoutError:
        return result("timeout", "连接超时。请确认两台设备在同一网络，再检查防火墙或访客网络隔离。", **detail)
    except (ValueError, http.client.HTTPException):
        return result("other_service", "端口没有返回有效的近传响应，请检查端口。", **detail)
    except OSError:
        return result("unreachable", "连接中断或地址不可达，请确认对方网络和设备地址。", **detail)
    finally:
        conn.close()


def check_resume_peer(source, address):
    if not isinstance(source, str):
        raise TransferError("发送设备无效", 403)
    with FILE_LOCK:
        peer = PEERS.get(source)
        if source == ME["id"] or not peer or peer.get("ip") != address:
            raise TransferError("发送设备未建立连接", 403)


TASK_FIELDS = ("id", "peerId", "direction", "kind", "name", "size", "doneBytes",
               "speed", "status", "path", "msgId", "start", "time", "retryable", "control", "error")


def outbox_record(tid):
    return DATA_DIR / "transfers-out" / (tid + ".json")


def outbox_view(task):
    return {k: task[k] for k in TASK_FIELDS if k in task}


def update_outbox(task, **changes):
    with OUTBOX_LOCK:
        record = dict(task, **changes)
        write_record(outbox_record(task["id"]), record)
        task.update(changes)
        view = outbox_view(task)
        with FILE_LOCK:
            TRANSFERS[task["id"]] = view
        push_progress(view)
        return view


def load_outbox():
    OUTBOX.clear()
    OUTBOX_ACTIVE.clear()
    TRANSFERS.clear()
    for path in (DATA_DIR / "transfers-out").glob("*.json"):
        task = read_record(path)
        if not task or task.get("id") != path.stem:
            continue
        state = task.get("status")
        if "remoteStarted" not in task:
            task["remoteStarted"] = True  # Existing v1.6.0 jobs may have a retained receiver partial.
        if "control" not in task:
            task["control"] = PEERS.get(task.get("peerId"), {}).get("transferControl") is True
        if state in ("running", "verifying"):
            task.update(status="error", speed=0, error="上次传输中断，点击重试可接着传。")
        elif state == "pausing":
            task.update(status="paused", speed=0, error="本机已暂停，接收端未确认。继续时会重新核对进度。")
        elif state == "canceling":
            task.update(status="cancel_wait", speed=0, error="上次清理尚未确认，请重试清理。")
        if state != task.get("status"):
            write_record(path, task)
        OUTBOX[task["id"]] = task
        if not task.get("dismissed"):
            TRANSFERS[task["id"]] = outbox_view(task)


def start_outbox(d):
    pid = d.get("peerId")
    with FILE_LOCK:
        peer = dict(PEERS.get(pid, {})) if isinstance(pid, str) else {}
    if not peer or peer.get("resume") is not True:
        raise TransferError("对方尚未支持续传，请先更新双方的近传。", 409)
    ref, size, checksum = d.get("path"), d.get("size"), d.get("sha256")
    name = Path(safe_rel(str(d.get("name") or "文件"))).name
    task = dict(id=new_id("t-"), msgId=new_id("m-"), peerId=pid, name=name, path=ref,
                time=now_ms(), start=time.time(), size=size, doneBytes=0, speed=0, status="running",
                direction="out", retryable=True, kind="image" if d.get("kind") == "image" else "file",
                control=peer.get("transferControl") is True, remoteStarted=False,
                sha256=checksum, reply=d.get("reply") if isinstance(d.get("reply"), dict) else None)
    with OUTBOX_LOCK:
        path = resolve_media_path(ref)
        if not (path and CACHE_DIR.resolve() in path.parents and path.is_file() and type(size) is int
                and path.stat().st_size == size and isinstance(checksum, str) and DIGEST.fullmatch(checksum)):
            raise TransferError("发送缓存缺失或不完整，请重新选择文件。")
        view = update_outbox(task)
        OUTBOX[task["id"]] = task
        start_outbox_worker(task)
        return view


def control_outbox(tid, action):
    with OUTBOX_LOCK:
        task = OUTBOX.get(tid) if isinstance(tid, str) else None
        if not task:
            raise TransferError("未找到传输任务", 404)
        state = task["status"]
        if action == "retry" and state in ("paused", "error"):
            new_state = "running"
        elif action == "pause" and state == "running" and task.get("control"):
            new_state = "pausing"
        elif action == "cancel" and (state == "cancel_wait" or
                state in ("running", "paused", "error") and task.get("control")):
            new_state = "canceling"
        else:
            raise TransferError("任务状态已变化，请查看最新进度。", 409)
        view = update_outbox(task, status=new_state, speed=0, error="")
        start_outbox_worker(task)
        return view


def resume_response(status, data, default):
    if not isinstance(data, dict) or status != 200 or data.get("ok") is not True:
        data = data if isinstance(data, dict) else {}
        raise TransferError(str(data.get("error") or f"{default}（HTTP {status}）"),
                            status, offset=data.get("offset"))
    return data


def send_chunk(peer, query, payload):
    conn = http.client.HTTPConnection(peer["ip"], int(peer["http"]), timeout=15)
    try:
        conn.request("POST", "/api/file/resume/append?" + urllib.parse.urlencode(query),
                     body=payload, headers={"Content-Type": "application/octet-stream"})
        response = conn.getresponse()
        try:
            data = json.loads(response.read(8192))
        except ValueError:
            data = {}
        return resume_response(response.status, data, "接收端未确认分块")
    finally:
        conn.close()


def file_message(record, direction, media):
    return dict(msgId=record["msgId"], dir=direction, type=record["kind"], text="",
                fileName=record["name"], size=record["size"], media=media, time=record["time"],
                status="done", reply=record.get("reply"))


def outbox_peer(task, require_control=False):
    with FILE_LOCK:
        peer = dict(PEERS.get(task["peerId"], {}))
    if not peer:
        raise TransferError("好友不在列表里，请重新添加后再试。")
    code, identity = post_to(peer, "/api/register", my_announce(reply=True))
    if code != 200 or not isinstance(identity, dict) or identity.get("id") != task["peerId"]:
        raise TransferError("地址上的设备与会话不匹配，请运行连接诊断。")
    if identity.get("resume") is not True:
        raise TransferError("对方当前版本不支持续传，请检查对方版本。")
    if require_control and identity.get("transferControl") is not True:
        raise TransferError("对方尚未支持暂停或清理，请确认对方使用 v1.6.1 或更新版本。")
    with FILE_LOCK:
        saved = PEERS.get(task["peerId"])
        capability = identity.get("transferControl") is True
        if saved and saved.get("transferControl") is not capability:
            saved["transferControl"] = capability
            save_peers()
            refresh()
    return peer, capability


def confirmed_offset(task, result):
    offset = result.get("offset")
    if type(offset) is not int or not 0 <= offset <= task["size"]:
        raise TransferError("接收端返回了无效的续传进度。")
    return offset


def complete_outbox(task, done):
    if done.get("complete") is not True or confirmed_offset(task, done) != task["size"]:
        raise TransferError("接收端尚未确认完整文件，请重试。")
    add_message(task["peerId"], file_message(task, "out", task["path"]))
    update_outbox(task, status="done", doneBytes=task["size"], speed=0, error="")


def send_outbox_data(task):
    # Waiting tasks do not have to wait for a busy transfer slot in order to pause/cancel.
    while task["status"] == "running":
        if OUTBOX_SLOTS.acquire(timeout=.15):
            break
    else:
        return
    try:
        if task["status"] != "running":
            return
        path = resolve_media_path(task["path"])
        if not path or not path.is_file() or path.stat().st_size != task["size"]:
            raise TransferError("本机文件缓存已丢失或变化，请重新选择文件。")
        peer, can_control = outbox_peer(task)
        with OUTBOX_LOCK:
            if task["status"] != "running":
                return
            update_outbox(task, remoteStarted=True, control=can_control)
        meta = {k: task[k] for k in ("id", "msgId", "kind", "name", "size", "sha256", "reply", "time")}
        meta["from"] = ME["id"]
        state = resume_response(*post_to(peer, "/api/file/resume/status", meta),
                                "接收端未返回续传进度")
        offset = confirmed_offset(task, state)
        update_outbox(task, doneBytes=offset, speed=0)
        with path.open("rb") as stream:
            stream.seek(offset)
            while offset < task["size"]:
                if task["status"] != "running":
                    return
                tick = time.monotonic()
                count = min(MAX_CHUNK, task["size"] - offset)
                payload = stream.read(count)
                if len(payload) != count:
                    raise TransferError("本机缓存不完整，请重新选择文件。")
                chunk = send_chunk(peer, {"id": task["id"], "from": ME["id"], "offset": offset}, payload)
                if confirmed_offset(task, chunk) != offset + count:
                    raise TransferError("接收端确认的分块进度异常，请重试。")
                offset += count
                update_outbox(task, doneBytes=offset, speed=round(count / max(.01, time.monotonic() - tick)))
        # Committing verification is linearized with user controls, so a cancelled task never
        # concurrently moves bytes into the recipient's final download directory.
        with OUTBOX_LOCK:
            if task["status"] != "running":
                return
            update_outbox(task, status="verifying", speed=0)
        done = resume_response(*post_to(peer, "/api/file/resume/finish",
                                {"id": task["id"], "from": ME["id"]}, timeout=300),
                               "接收端未完成文件校验")
        complete_outbox(task, done)
    finally:
        OUTBOX_SLOTS.release()


def remove_outbox_cache(task):
    ref = task["path"]
    with OUTBOX_LOCK, FILE_LOCK:
        path = resolve_media_path(ref)
        if not path or CACHE_DIR.resolve() not in path.parents:
            return
        if any(item is not task and item.get("path") == ref and item["status"] != "canceled"
               for item in OUTBOX.values()):
            return
        if any(m.get("media") == ref for items in MESSAGES.values() for m in items):
            return
        path.unlink(missing_ok=True)


def pause_or_cancel_outbox(task, action):
    if task.get("remoteStarted"):
        peer, _ = outbox_peer(task, require_control=True)
        state = resume_response(*post_to(peer, "/api/file/resume/" + action,
                                 {"id": task["id"], "from": ME["id"]}, timeout=20),
                                "接收端未确认传输操作")
        if state.get("complete") is True:
            complete_outbox(task, state)
            return
        if state.get("paused" if action == "pause" else "canceled") is not True:
            raise TransferError("接收端未确认传输操作。")
        offset = confirmed_offset(task, state)
    else:
        offset = 0
    if action == "pause":
        update_outbox(task, status="paused", doneBytes=offset, speed=0, error="")
    else:
        with OUTBOX_LOCK:
            remove_outbox_cache(task)
            update_outbox(task, status="canceled", doneBytes=0, speed=0, error="", path="")


def start_outbox_worker(task):
    """Only one worker per durable job. Caller holds OUTBOX_LOCK."""
    if task["id"] not in OUTBOX_ACTIVE:
        OUTBOX_ACTIVE.add(task["id"])
        threading.Thread(target=send_outbox_worker, args=(task,), daemon=True).start()


def send_outbox_worker(task):
    mode = task["status"]
    try:
        if mode == "running":
            send_outbox_data(task)
        elif mode == "pausing":
            pause_or_cancel_outbox(task, "pause")
        elif mode == "canceling":
            pause_or_cancel_outbox(task, "cancel")
    except (TransferError, OSError, http.client.HTTPException) as exc:
        reason = (str(exc) if isinstance(exc, TransferError) else
                  "对方可能离线或未打开近传。" if isinstance(exc, ConnectionRefusedError) else
                  "连接超时，请确认对方仍在同一网络。" if isinstance(exc, TimeoutError) else
                  "网络连接或文件操作中断。")
        with OUTBOX_LOCK:
            if mode == "running" and task["status"] in ("running", "verifying"):
                confirmed = exc.detail.get("offset") if isinstance(exc, TransferError) else None
                extra = {"doneBytes": confirmed} if type(confirmed) is int and 0 <= confirmed <= task["size"] else {}
                update_outbox(task, status="error", speed=0, error=reason, **extra)
            elif mode == "pausing" and task["status"] == "pausing":
                update_outbox(task, status="paused", speed=0, error="本机已暂停，接收端未确认。继续时会重新核对进度。")
            elif mode == "canceling" and task["status"] == "canceling":
                update_outbox(task, status="cancel_wait", speed=0, error=reason + " 请在对方在线时重试清理。")
    finally:
        with OUTBOX_LOCK:
            OUTBOX_ACTIVE.discard(task["id"])
            if sys.exc_info()[0] is None and task["status"] in ("running", "pausing", "canceling"):
                start_outbox_worker(task)


def receive_progress(record, offset, status="running", path="", error=""):
    tid = "r-" + ChunkStore.key(record["from"], record["id"])
    task = dict(id=tid, peerId=record["from"], direction="in", kind=record["kind"],
                name=record["name"], msgId=record["msgId"], size=record["size"], doneBytes=offset,
                speed=0, status=status, start=record["time"] / 1000, path=path, error=error,
                lastActivity=time.monotonic())
    with FILE_LOCK:
        TRANSFERS[tid] = task
        push_progress(task)


def restore_inbox_progress():
    for record, offset in RESUME_STORE.unfinished():
        if record.get("paused"):
            receive_progress(record, offset, "paused")
        else:
            receive_progress(record, offset, "waiting", error="等待对方继续传输。")


def finish_inbox(record, ref):
    add_message(record["from"], file_message(record, "in", ref))
    receive_progress(record, record["size"], "done", ref)


def register_addr(address, retry=6):
    """手动添加好友：直接向对方 HTTP /api/register 报到。
    支持 "192.168.1.7" / "192.168.1.7:8765" / "http://192.168.1.7:8765"。
    """
    address = (address or "").strip()
    if not address:
        return False, "地址为空"
    addr = address.replace("http://", "").replace("https://", "").strip("/")
    if ":" in addr:
        host, port = addr.rsplit(":", 1)
        try:
            port = int(port)
        except ValueError:
            return False, "端口格式错误"
    else:
        host, port = addr, DEFAULT_HTTP_PORT
    for i in range(retry):
        try:
            status, data = post_to({"ip": host, "http": port},
                                   "/api/register", my_announce(reply=True), timeout=3)
            if status == 200 and data.get("id"):
                update_peer(data, host, manual=True)
                refresh()
                return True, "已添加 {}".format(data.get("name", host))
        except Exception:
            pass
        if i < retry - 1:
            time.sleep(1.5)
    return False, "无法连接 {}（确认对方已启动、同一局域网、防火墙放行）".format(address)


# ----------------------------------------------------------------------------
# 群聊：本地建群 / 成员同步 / 群消息扇出
#   groups.json 结构：{"groups": {gid: {id,name,avatarText,avatarColor,
#                                       owner,members:[peerId...],createdAt,updatedAt}}}
#   members 里不含自己；消息仍然存在 MESSAGES[gid] 里，和单聊同一套渲染。
# ----------------------------------------------------------------------------
GROUPS = {}
GROUPS_FILE = DATA_DIR / "groups.json"


def load_groups():
    global GROUPS
    GROUPS = load_json(GROUPS_FILE, {}).get("groups", {})


def save_groups():
    save_json(GROUPS_FILE, {"groups": GROUPS})


def is_group(cid):
    return bool(cid) and cid in GROUPS


def group_view(g):
    d = dict(g)
    d["members"] = list(g.get("members") or [])
    d["admins"] = list(g.get("admins") or [])
    d["memberCount"] = len(d["members"]) + 1
    me = ME.get("id")
    d["role"] = ("owner" if g.get("owner") == me
                 else "admin" if me in d["admins"] else "member")
    online = 0
    for pid in d["members"]:
        p = PEERS.get(pid)
        if p and time.time() - p.get("last_seen", 0) < PEER_TIMEOUT:
            online += 1
    d["onlineCount"] = online
    d["displayName"] = g.get("name") or "群聊"
    return d


def group_member_peers(g):
    out = []
    for pid in g.get("members") or []:
        p = PEERS.get(pid)
        if p:
            out.append(p)
    return out


def fanout_group(g, path, payload, exclude=None, media_by_peer=None):
    """把 payload 依次 POST 给群成员（跳过自己/离线/指定的 id）。"""
    sent, failed = 0, 0
    for pid in g.get("members") or []:
        if exclude and pid == exclude:
            continue
        p = PEERS.get(pid)
        if not p or time.time() - p.get("last_seen", 0) >= PEER_TIMEOUT:
            failed += 1
            continue
        try:
            wire = payload
            if media_by_peer is not None:
                media = media_by_peer.get(pid)
                if not media:
                    failed += 1
                    continue
                wire = dict(payload, msg=dict(payload["msg"], media=media))
            status, _ = post_to(p, path, wire, timeout=4)
            if status == 200:
                sent += 1
            else:
                failed += 1
        except Exception:
            failed += 1
    return sent, failed


def upsert_group(g, sender=None, removed=None):
    """接收端：按 id 建/更新群。

    members 的语义是「除我以外的人」，所以：
      * 收进来的列表要先把自己去掉；
      * 发送者在自己的列表里不出现，得补回来，否则回消息会漏发给他；
      * 默认取并集（局域网里丢一次包不该把成员弄丢），显式 removed 才删。
    """
    gid = g.get("id")
    if not gid:
        return None
    old = GROUPS.get(gid) or {}
    me = ME.get("id")
    members = set(old.get("members") or [])
    if isinstance(g.get("members"), list):
        members |= {str(x) for x in g["members"] if x}
    if sender:
        members.add(str(sender))
    members.discard(me)
    for rid in (removed or []):
        members.discard(str(rid))
    admins = set(old.get("admins") or [])
    if isinstance(g.get("admins"), list):
        fresh = {str(x) for x in g["admins"] if x}
        # 群主发来的列表是权威的（撤管理员才能生效），其他人只做并集
        admins = fresh if (sender and sender == g.get("owner")) else (admins | fresh)
    # admins 里允许出现自己（否则接收端算不出自己的「管理员」身份）
    admins &= set(members) | {me}
    data = dict(old)
    for k in ("name", "avatarText", "avatarColor", "owner", "updatedAt", "note"):
        v = g.get(k)
        if v not in (None, ""):
            data[k] = v
    if g.get("avatarKey") in (*AVATAR_KEYS, "group"):
        data["avatarKey"] = g["avatarKey"]
    data["id"] = gid
    data["members"] = sorted(members)
    data["admins"] = sorted(admins)
    data.setdefault("name", "群聊")
    data.setdefault("createdAt", now_ms())
    GROUPS[gid] = data
    save_groups()
    refresh()
    return data


def add_message(peer_id, msg):
    """写入一条消息，按 msgId 去重（接收完成与 /api/message 可能前后到达）。"""
    with FILE_LOCK:
        arr = MESSAGES.setdefault(peer_id, [])
        mid = msg.get("msgId")
        for old in arr:
            if mid and old.get("msgId") == mid:
                for k, v in msg.items():
                    if v not in (None, ""):
                        old[k] = v
                save_messages()
                refresh()
                return old
        arr.append(msg)
        if len(arr) > 800:
            del arr[:len(arr) - 800]
        save_messages()
        if msg.get("dir") == "in":
            UNREAD[peer_id] = int(UNREAD.get(peer_id, 0)) + 1
    # 新的入站消息：未读 +1，并通知桌面外壳（右下角消息卡片 / 托盘提示）
    if msg.get("dir") == "in":
        if DESKTOP:
            try:
                DESKTOP.on_message(peer_id, msg)
            except Exception:
                pass
    refresh()
    return msg


# ----------------------------------------------------------------------------
# UDP 发现（组播 + 广播 + 子网定向 + HTTP 兜底）
# ----------------------------------------------------------------------------
def udp_targets():
    t = {(MCAST_GRP, int(CONFIG["udp_port"])),
         ("255.255.255.255", int(CONFIG["udp_port"]))}
    for ip in local_ips():
        try:
            t.add((ip.rsplit(".", 1)[0] + ".255", int(CONFIG["udp_port"])))
        except Exception:
            pass
    return t


def udp_sender_loop():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, struct.pack("B", 2))
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, struct.pack("B", 1))
    except Exception:
        pass
    while True:
        try:
            payload = json.dumps(my_announce(), ensure_ascii=False).encode("utf-8")
            for target in udp_targets():
                try:
                    s.sendto(payload, target)
                except Exception:
                    pass
            expire_peers()
        except Exception as e:
            print("[warn] 宣告失败:", e)
        time.sleep(ANNOUNCE_INTERVAL)


def udp_listener_loop():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except Exception:
        pass
    try:
        s.bind(("", int(CONFIG["udp_port"])))
    except Exception as e:
        print("[warn] UDP {} 端口绑定失败（自动发现可能不可用，请用手动添加好友）: {}".format(
            CONFIG["udp_port"], e))
        return
    try:
        mreq = socket.inet_aton(MCAST_GRP) + socket.inet_aton("0.0.0.0")
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    except Exception:
        pass
    while True:
        try:
            data, addr = s.recvfrom(65535)
            info = json.loads(data.decode("utf-8"))
            if info.get("type") != "announce" or info.get("id") == ME["id"]:
                continue
            update_peer(info, addr[0])
            if not info.get("reply"):
                # 单播回执：让对方立刻也看到我（LocalSend announce/response 思路）
                try:
                    s.sendto(json.dumps(my_announce(reply=True),
                                        ensure_ascii=False).encode("utf-8"),
                             (addr[0], int(CONFIG["udp_port"])))
                except Exception:
                    pass
        except Exception:
            continue


def legacy_keepalive_loop():
    """组播被禁时的 HTTP 兜底：对已知好友定期报到，保持双向在线。"""
    time.sleep(3)
    while True:
        try:
            with FILE_LOCK:
                targets = [(p["ip"], int(p["http"])) for p in PEERS.values()]
            for ip, port in targets:
                try:
                    status, data = post_to({"ip": ip, "http": port},
                                           "/api/register", my_announce(reply=True), timeout=2)
                    if status == 200 and data.get("id"):
                        update_peer(data, ip)
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(LEGACY_INTERVAL)


# ----------------------------------------------------------------------------
# WebSocket（标准库手写，仅服务端 -> 客户端推送）
# ----------------------------------------------------------------------------
class WSClient:
    def __init__(self, handler):
        self.h = handler
        self.lock = threading.Lock()
        self.alive = True

    def send_frame(self, opcode, data):
        header = bytearray()
        header.append(0x80 | opcode)
        n = len(data)
        if n < 126:
            header.append(n)
        elif n < 65536:
            header.append(126)
            header += struct.pack("!H", n)
        else:
            header.append(127)
            header += struct.pack("!Q", n)
        with self.lock:
            try:
                self.h.connection.sendall(bytes(header) + data)
            except Exception:
                self.alive = False

    def send(self, obj):
        if self.alive:
            self.send_frame(0x1, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            c = self.h.rfile.read(n - len(buf))
            if not c:
                return None
            buf += c
        return buf

    def _recv_frame(self):
        h = self._read_exact(2)
        if not h:
            return None
        opcode = h[0] & 0x0F
        masked = h[1] & 0x80
        n = h[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", self._read_exact(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(n) if n else b""
        if payload is None:
            return None
        if mask:
            payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        return opcode, payload

    def loop(self):
        while self.alive:
            try:
                frame = self._recv_frame()
            except Exception:
                break
            if frame is None:
                break
            op, payload = frame
            if op == 0x8:      # close
                break
            if op == 0x9:      # ping -> pong
                self.send_frame(0xA, payload)
            # 文本帧由前端忽略；指令统一走 HTTP API
        self.alive = False


# ----------------------------------------------------------------------------
# HTTP 服务
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JinChuan/" + VERSION   # HTTP 头必须是 ASCII，不能放中文产品名

    def log_message(self, fmt, *args):
        pass

    # ---- 响应封装 ---------------------------------------------------------
    def _respond(self, code, body=b"", ctype="application/json; charset=utf-8",
                 extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Access-Control-Request-Private-Network")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            try:
                self.wfile.write(body)
            except Exception:
                pass

    def _json(self, obj, code=200):
        self._respond(code, json.dumps(obj, ensure_ascii=False))

    def _parse_qs(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _path(self):
        return urllib.parse.urlparse(self.path).path

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def do_OPTIONS(self):
        self._respond(204)

    # ---- GET --------------------------------------------------------------
    def do_GET(self):
        p, q = self._path(), self._parse_qs()

        if p == "/ws/game":
            return self._ws_handshake(game=(q.get("room", [""])[0],
                                            q.get("seat", ["0"])[0],
                                            q.get("name", [""])[0],
                                            avatar_key(q.get("avatar", [""])[0])))

        if p == "/ws":
            return self._ws_handshake()

        if (p in ("/", "/index.html", "/appearance.js") or p.startswith("/static/")
                or p.startswith("/games/") or p.endswith(".html")):
            if p in ("/", "/index.html"):
                name = "index.html"
            elif p.startswith("/static/"):
                name = p[len("/static/"):]
            elif p.startswith("/games/"):
                name = "games/" + p[len("/games/"):]
            else:
                # mini.html / popup.html（托盘悬浮窗、消息弹窗等独立小页面）
                name = p.lstrip("/")
            try:
                f = (WEB_DIR / name).resolve()
                if WEB_DIR.resolve() not in f.parents and f != WEB_DIR.resolve() / name:
                    raise ValueError("bad path")
                data = f.read_bytes()
            except Exception:
                return self._respond(404, "Not Found", "text/plain; charset=utf-8")
            ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            # 本地资源禁止缓存：更新 exe 后 WebView2 不会继续吃旧 CSS/JS
            return self._respond(200, data, ctype,
                                 {"Cache-Control": "no-cache, no-store, must-revalidate",
                                  "Pragma": "no-cache"})

        if p == "/api/state":
            return self._json(state_snapshot())

        # 在线更新：检查 / 进度（GET，方便浏览器直接看）
        if p == "/api/update/check":
            return self._json(check_update(force=q.get("force", ["0"])[0] == "1"))

        if p == "/api/update/status":
            with UPDATE_LOCK:
                return self._json(dict(UPDATE))

        if p == "/api/mj/seat":
            rid = q.get("room", [""])[0]
            with GAME_LOCK:
                used = set(GAME_SEATS.get(rid, ()))
                active = bool(GAME_HOSTS.get(rid))
            if not active:
                return self._json({"ok": False, "code": "ROOM_NOT_FOUND", "seat": None, "used": []}, 404)
            free = next((n for n in (1, 2, 3) if n not in used), None)
            return self._json({"ok": free is not None, "seat": free, "used": sorted(used)})

        if p == "/api/mj/relay":
            rid = q.get("room", [""])[0]
            since = int(q.get("since", ["0"])[0] or 0)
            with MJ_RELAY_LOCK:
                st = MJ_RELAY.get(rid) or {"view": None, "actions": [], "seq": 0}
                return self._json({"ok": True, "view": st["view"],
                                   "actions": [a for a in st["actions"] if a["seq"] > since],
                                   "cursor": st["seq"]})

        if p == "/api/mj/state":
            rid = q.get("room", [""])[0]
            pid = q.get("pid", [""])[0]
            room = mj.ROOMS.get(rid)
            if not room:
                return self._json({"ok": False, "error": "房间不存在"}, 404)
            mj.auto_bot(room, now_ms())
            return self._json(mj.view(room, pid))

        # 小游戏：房间状态（房主进程是裁判，其他人轮询这个接口）
        if p == "/api/game/state":
            rid = q.get("room", [""])[0]
            pid = q.get("pid", [""])[0]
            room = GAMES.get(rid)
            if not room:
                return self._json({"ok": False, "error": "房间不存在"}, 404)
            with GAME_LOCK:
                ddz_auto(room)
                return self._json(ddz_public(room, pid))

        if p == "/api/ping":
            return self._json({"ok": True, "id": ME["id"], "name": ME["name"],
                               "version": VERSION, "platform": platform.system(), "resume": True, "transferControl": True})

        if p in ("/api/media", "/api/download"):
            rel = q.get("path", [""])[0]
            return self._serve_file(rel, download=(p == "/api/download") or
                                    q.get("dl", ["0"])[0] == "1")

        if p == "/api/help":
            return self._json({"ok": True, "help": HELP_TEXT})

        return self._respond(404, "Not Found", "text/plain; charset=utf-8")

    def _serve_file(self, rel, download=False):
        f = resolve_media_path(rel)
        if f is None or not f.is_file():
            return self._respond(404, "File Not Found", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        disp = "attachment" if download else "inline"
        try:
            with f.open("rb") as source:
                size = os.fstat(source.fileno()).st_size
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Disposition", "{}; filename*=UTF-8''{}".format(disp, urllib.parse.quote(f.name)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                while True:
                    block = source.read(CHUNK)
                    if not block:
                        break
                    self.wfile.write(block)
        except (OSError, ConnectionError):
            self.close_connection = True

    def _ws_handshake(self, game=None):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or self.headers.get("Upgrade", "").lower() != "websocket":
            return self._respond(400, "Bad WebSocket Request", "text/plain")
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        resp = ("HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: {}\r\n\r\n".format(accept))
        try:
            self.connection.sendall(resp.encode("ascii"))
        except Exception:
            return
        self.close_connection = True
        client = WSClient(self)

        if game:
            # 麻将房间：只在同房间内广播（房主推 state，客人推 action）
            room, seat, name, avatar = game
            with GAME_LOCK:
                seat_n, error = claim_game_seat(room, seat)
                if not error:
                    client.game_seat = seat_n
                    GAME_SEATS.setdefault(room, {})[seat_n] = name or str(seat_n)
                    GAME_ROOMS.setdefault(room, set()).add(client)
                    if seat_n == 0:
                        GAME_HOSTS[room] = {id(client): True}
                    client.send({"t": "seated", "room": room, "seat": seat_n})
            if error:
                client.send({"t": "error", "code": error, "fatal": True})
                client.send_frame(0x8, b"")
                return
            is_host = seat_n == 0
            game_relay(room, {"t": "join", "seat": seat_n, "name": name,
                              "avatarKey": avatar}, exclude=client)
            try:
                while client.alive:
                    frame = client._recv_frame()
                    if frame is None:
                        break
                    op, payload = frame
                    if op == 0x8:
                        break
                    if op != 0x1:
                        continue
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                    except Exception:
                        continue
                    t = str(msg.get("t") or "")
                    if is_host:
                        # 房主只下发局面，别再转发自己的 action 给所有人
                        if t not in ("state", "error"):
                            continue
                        to = msg.get("to")
                        if to is None:
                            if t == "state" and "private" not in msg:
                                game_relay(room, msg, exclude=client)
                        else:
                            with GAME_LOCK:
                                recipients = [c for c in GAME_ROOMS.get(room, ())
                                              if c is not client and c.game_seat == to]
                            for target in recipients:
                                target.send(msg)
                    else:
                        # 客人只发 action/join 给房主，不互相广播
                        if t not in ("action", "join", "bye", "ready", "profile"):
                            continue
                        with GAME_LOCK:
                            hs = list((GAME_HOSTS.get(room) or {}).keys())
                            rs = list(GAME_ROOMS.get(room) or ())
                        msg["seat"] = seat_n
                        if t == "profile":
                            name = str(msg.get("name") or name).strip()[:24] or name
                            avatar = avatar_key(msg.get("avatarKey"))
                            with GAME_LOCK:
                                if seat_n in (GAME_SEATS.get(room) or {}):
                                    GAME_SEATS[room][seat_n] = name
                        if t in ("join", "profile"):
                            msg["name"] = name
                            msg["avatarKey"] = avatar
                        for c in rs:
                            if id(c) in hs:
                                try:
                                    c.send(msg)
                                except Exception:
                                    pass
            finally:
                with GAME_LOCK:
                    GAME_ROOMS[room].discard(client)
                    GAME_SEATS[room].pop(seat_n, None)
                    if is_host:
                        GAME_HOSTS.pop(room, None)
                    if not GAME_ROOMS[room]:
                        GAME_ROOMS.pop(room)
                        GAME_SEATS.pop(room, None)
                game_relay(room, {"t": "bye", "seat": seat_n, "reason": "host_left" if is_host else "leave"})
            return

        with WS_LOCK:
            WS_CLIENTS.add(client)
        try:
            client.send({"type": "hello", "me": dict(ME)})
            client.loop()
        finally:
            with WS_LOCK:
                WS_CLIENTS.discard(client)

    # ---- POST -------------------------------------------------------------
    def do_POST(self):
        """统一兜底：任何未预料的异常都要以 JSON 返回，不能让前端拿到断连。

        之前少写了 set_autostart，设置面板一保存就 NameError → 连接被关闭 →
        前端 fetch 直接抛 "Failed to fetch"，界面上完全没反应。
        """
        try:
            return self._do_post()
        except Exception as e:                                   # noqa: BLE001
            import traceback
            traceback.print_exc()
            try:
                return self._json({"ok": False, "error": "服务端异常: {}".format(e)}, 500)
            except Exception:
                return

    def _do_post(self):
        p, q = self._path(), self._parse_qs()

        # 节点间：注册（手动添加好友 / HTTP 兜底）
        if p == "/api/register":
            info = self._body()
            update_peer(info, self.client_address[0])
            return self._json(dict(ME))

        # 节点间：收到聊天消息
        if p == "/api/message":
            m = self._body()
            pid = m.get("from", "")
            if not pid:
                return self._json({"ok": False, "error": "missing from"}, 400)
            msg = {
                "msgId": m.get("msgId") or new_id("m-"),
                "dir": "in",
                "type": m.get("type", "text"),
                "text": m.get("text", ""),
                "fileName": m.get("fileName", ""),
                "size": m.get("size", 0),
                "media": m.get("media", ""),
                "reply": m.get("reply") or None,
                "time": m.get("time") or now_ms(),
                "status": "done"
            }
            if m.get("game"):
                msg["game"] = m["game"]        # 游戏邀请卡片
            add_message(pid, msg)
            broadcast({"type": "toast", "from": m.get("fromName", "好友"),
                       "text": "发来一条消息"})
            return self._json({"ok": True})

        # 节点间：对方撤回了一条消息
        if p == "/api/peer/recall":
            d = self._body()
            pid, mid = d.get("from", ""), d.get("msgId", "")
            changed = False
            with FILE_LOCK:
                for msg in MESSAGES.get(pid, []):
                    if msg.get("msgId") == mid and msg.get("type") != "recalled":
                        msg["type"] = "recalled"
                        msg["text"] = ""
                        msg["media"] = ""
                        msg["fileName"] = ""
                        msg["recalledBy"] = "peer"
                        changed = True
                if changed:
                    save_messages()
            if changed:
                refresh()
            return self._json({"ok": True})

        # 节点间：群里有人撤回了消息
        if p == "/api/group/recall":
            d = self._body()
            gid, mid = d.get("groupId", ""), d.get("msgId", "")
            changed = False
            with FILE_LOCK:
                for msg in MESSAGES.get(gid, []):
                    if msg.get("msgId") == mid and msg.get("type") != "recalled":
                        msg["type"] = "recalled"
                        msg["text"] = ""
                        msg["media"] = ""
                        msg["fileName"] = ""
                        msg["recalledBy"] = "peer"
                        changed = True
                if changed:
                    save_messages()
            if changed:
                refresh()
            return self._json({"ok": True})

        # 本地 UI：撤回自己的消息（2 分钟内，QQ 规则），并通知对方同步删除
        if p == "/api/recall":
            d = self._body()
            pid, mid = d.get("id", ""), d.get("msgId", "")
            target = None
            with FILE_LOCK:
                for msg in MESSAGES.get(pid, []):
                    if msg.get("msgId") == mid:
                        target = msg
                        break
                if target is None:
                    return self._json({"ok": False, "error": "消息不存在"}, 404)
                if target.get("dir") != "out":
                    return self._json({"ok": False, "error": "只能撤回自己发的消息"}, 400)
                if target.get("type") == "recalled":
                    return self._json({"ok": True})
                if now_ms() - int(target.get("time") or 0) > 120000:
                    return self._json({"ok": False, "error": "超过 2 分钟，无法撤回"}, 400)
                target["type"] = "recalled"
                target["text"] = ""
                target["fileName"] = ""
                target["recalledBy"] = "me"
                save_messages()
                peer = dict(PEERS.get(pid, {}))
                grp = dict(GROUPS.get(pid, {}))
            refresh()
            if grp:
                fanout_group(grp, "/api/group/recall",
                             {"groupId": pid, "msgId": mid, "from": ME["id"]})
            elif peer:
                try:
                    post_to(peer, "/api/peer/recall", {"msgId": mid, "from": ME["id"]}, timeout=4)
                except Exception:
                    pass
            return self._json({"ok": True})

        # 本地 UI：发送消息（后端统一落库 + 转发给对端）
        if p == "/api/send":
            return self._api_send(self._body())

        # 本地 UI：手动添加好友
        if p == "/api/peer/add":
            address = self._body().get("address", "")
            ok, text = register_addr(address, retry=2)
            return self._json({"ok": ok, "message": text})

        # 本地 UI：编辑好友信息（备注名 / 头像文字 / 头像颜色 / 分组 / 备注 / 置顶）
        if p == "/api/peer/edit":
            d = self._body()
            pid = d.get("id")
            with FILE_LOCK:
                peer = PEERS.get(pid)
                if not peer:
                    return self._json({"ok": False, "error": "好友不存在"}, 404)
                for k in ("alias", "group", "note"):
                    if k in d:
                        peer[k] = str(d[k])[:80]
                if "pinned" in d:
                    peer["pinned"] = bool(d["pinned"])
                if "mute" in d:
                    peer["mute"] = bool(d["mute"])
                save_peers()
            refresh()
            return self._json({"ok": True})

        if p == "/api/peer/remove":
            pid = self._body().get("id")
            with FILE_LOCK:
                PEERS.pop(pid, None)
                save_peers()
            refresh()
            return self._json({"ok": True})

        if p == "/api/mj/relay/host":
            d = self._body()
            rid = str(d.get("room") or "")
            with MJ_RELAY_LOCK:
                st = MJ_RELAY.setdefault(rid, {"view": None, "actions": [], "seq": 0})
                st["view"] = d.get("view")
            return self._json({"ok": True})

        if p == "/api/mj/relay/action":
            d = self._body()
            rid = str(d.get("room") or "")
            with MJ_RELAY_LOCK:
                st = MJ_RELAY.setdefault(rid, {"view": None, "actions": [], "seq": 0})
                st["seq"] += 1
                st["actions"].append({"seq": st["seq"], "seat": d.get("seat"),
                                      "action": d.get("action")})
                if len(st["actions"]) > 200:
                    del st["actions"][:-100]
            return self._json({"ok": True})

        # ---------------- 四川麻将（血战到底） ----------------
        if p == "/api/mj/create":
            d = self._body()
            room = mj.new_room(ME["id"], ME["name"])
            mj.start(room, now_ms())
            mj.auto_bot(room, now_ms())
            return self._json({"ok": True, "room": room["id"], "state": mj.view(room, ME["id"])})

        if p == "/api/mj/join":
            d = self._body()
            rid = str(d.get("room") or "")
            room = mj.ROOMS.get(rid)
            if not room:
                return self._json({"ok": False, "error": "房间不存在"}, 404)
            pid = str(d.get("id") or "")
            name = str(d.get("name") or "玩家")[:16]
            if not any(x["id"] == pid for x in room["players"]):
                bots = [x for x in room["players"] if x["bot"]]
                if bots:
                    slot = bots[0]
                    slot.update({"id": pid, "name": name, "bot": False})
                else:
                    return self._json({"ok": False, "error": "房间满了"}, 400)
            mj.auto_bot(room, now_ms())
            return self._json({"ok": True, "state": mj.view(room, pid)})

        if p == "/api/mj/action":
            d = self._body()
            rid = str(d.get("room") or "")
            room = mj.ROOMS.get(rid)
            if not room:
                return self._json({"ok": False, "error": "房间不存在"}, 404)
            pid = str(d.get("pid") or "")
            me = next((x for x in room["players"] if x["id"] == pid), None)
            if not me:
                return self._json({"ok": False, "error": "你不在房间"}, 400)
            act = d.get("action") or {}
            kind = act.get("type")
            if kind == "que":
                ok, err = mj.set_que(room, me["seat"], int(act.get("suit", 0)), now_ms())
            elif kind == "discard":
                ok, err = mj.discard(room, me["seat"], int(act.get("tile", -1)), now_ms())
            else:
                ok, err = False, "未知操作"
            if not ok:
                return self._json({"ok": False, "error": err}, 400)
            mj.auto_bot(room, now_ms())
            return self._json({"ok": True, "state": mj.view(room, pid)})

        # ---------------- 小游戏（斗地主） ----------------
        if p == "/api/game/create":
            d = self._body()
            game = str(d.get("game") or "ddz")
            if game != "ddz":
                return self._json({"ok": False, "error": "这个游戏还没做"}, 400)
            room = ddz_new_room(ME["id"], ME["name"], game)
            with GAME_LOCK:
                ddz_start(room)
            return self._json({"ok": True, "room": room["id"],
                               "host": ME["id"], "state": ddz_public(room, ME["id"])})

        if p == "/api/game/join":
            d = self._body()
            rid = str(d.get("room") or "")
            pid = str(d.get("id") or "")
            name = str(d.get("name") or "玩家")[:16]
            room = GAMES.get(rid)
            if not room:
                return self._json({"ok": False, "error": "房间不存在或房主已退出"}, 404)
            with GAME_LOCK:
                if not any(x["id"] == pid for x in room["players"]):
                    humans = [x for x in room["players"] if not x["bot"]]
                    if len(humans) >= 3:
                        return self._json({"ok": False, "error": "房间满了"}, 400)
                    # 顶掉一个机器人
                    bots = [x for x in room["players"] if x["bot"]]
                    if bots:
                        room["players"].remove(bots[0])
                    seat = len(room["players"])
                    room["players"].append({"id": pid, "name": name,
                                            "seat": seat, "bot": False})
                    for i, x in enumerate(sorted(room["players"], key=lambda y: y["seat"])):
                        x["seat"] = i
                    if room["phase"] == "waiting":
                        ddz_start(room)
                return self._json({"ok": True, "state": ddz_public(room, pid)})

        if p == "/api/game/action":
            d = self._body()
            rid = str(d.get("room") or "")
            pid = str(d.get("pid") or "")
            act = d.get("action") or {}
            room = GAMES.get(rid)
            if not room:
                return self._json({"ok": False, "error": "房间不存在"}, 404)
            with GAME_LOCK:
                me = next((x for x in room["players"] if x["id"] == pid), None)
                if not me:
                    return self._json({"ok": False, "error": "你不在这个房间"}, 400)
                if room["phase"] not in ("bid", "play"):
                    return self._json({"ok": False, "error": "现在不能操作"}, 400)
                if me["seat"] != room["turn"]:
                    return self._json({"ok": False, "error": "还没轮到你"}, 400)
                kind = act.get("type")
                if kind == "bid":
                    if room["phase"] != "bid":
                        return self._json({"ok": False, "error": "不是叫地主阶段"}, 400)
                    # 叫分：1/2/3 分，必须比当前最高分大；都不要就由当前人 1 分兜底
                    score = int(act.get("score") or (1 if act.get("yes") else 0))
                    b = room.setdefault("bid", {"high": 0, "who": None, "acted": []})
                    if score > 3:
                        return self._json({"ok": False, "error": "最多叫 3 分"}, 400)
                    if score > 0 and score <= b["high"]:
                        return self._json({"ok": False,
                                           "error": "要比 %d 分高" % b["high"]}, 400)
                    if score > b["high"]:
                        b["high"], b["who"] = score, me["seat"]
                    if me["seat"] not in b["acted"]:
                        b["acted"].append(me["seat"])
                    all_acted = len(b["acted"]) >= len(room["players"])
                    if b["high"] == 3 or all_acted:
                        if b["who"] is None:
                            b["who"], b["high"] = me["seat"], 1
                        ddz_take_bottom(room, b["who"])
                    else:
                        ddz_next_turn(room)
                elif kind == "play":
                    cards = [int(x) for x in (act.get("cards") or [])]
                    ok, err = ddz_play(room, me["seat"], cards)
                    if not ok:
                        return self._json({"ok": False, "error": err}, 400)
                elif kind == "pass":
                    ok, err = ddz_pass(room, me["seat"])
                    if not ok:
                        return self._json({"ok": False, "error": err}, 400)
                else:
                    return self._json({"ok": False, "error": "未知操作"}, 400)
                ddz_auto(room)
                return self._json({"ok": True, "state": ddz_public(room, pid)})

        if p == "/api/game/invite":
            d = self._body()
            conv = str(d.get("conversation") or "")
            rid = str(d.get("room") or "")
            kind = str(d.get("kind") or "ddz")
            if not rid:
                return self._json({"ok": False, "error": "房间号为空"}, 400)
            if kind == "majiang":
                with GAME_LOCK:
                    room_ready = bool(GAME_HOSTS.get(rid))
            else:
                room_ready = rid in GAMES
            if not room_ready:
                return self._json({"ok": False, "error": "牌桌还没开好或已经关闭"}, 404)
            msg = {
                "msgId": new_id("m-"), "type": "game", "text": "",
                "game": {"kind": kind, "room": rid, "hostId": ME["id"],
                         "hostName": ME["name"], "ip": ME["ip"], "port": ME["http"]},
                "time": now_ms(), "dir": "out", "from": ME["id"], "fromName": ME["name"], "fromAvatarKey": ME["avatarKey"],
                "status": "done",
            }
            if is_group(conv):
                g = GROUPS[conv]
                payload = {"groupId": conv, "group": group_view(g), "msg": dict(msg)}
                sent, failed = fanout_group(g, "/api/group/message", payload)
                if not sent:
                    return self._json({"ok": False, "error": "群内暂无可接收邀请的好友"}, 502)
                add_message(conv, msg)
            else:
                peer = dict(PEERS.get(conv, {}))
                if not peer:
                    return self._json({"ok": False, "error": "对方不存在"}, 404)
                try:
                    status, reply = post_to(peer, "/api/message", {
                        "msgId": msg["msgId"], "from": ME["id"], "fromName": ME["name"], "fromAvatarKey": ME["avatarKey"],
                        "type": "game", "text": "", "fileName": "", "size": 0,
                        "media": "", "time": msg["time"], "game": msg["game"],
                    }, timeout=4)
                except (OSError, http.client.HTTPException):
                    status, reply = 0, {}
                if status != 200 or not reply.get("ok"):
                    return self._json({"ok": False, "error": "邀请未送达，请确认好友在线"}, 502)
                sent, failed = 1, 0
                add_message(conv, msg)
            return self._json({"ok": True, "msgId": msg["msgId"], "sent": sent, "failed": failed})

        # ---------------- 群聊 ----------------
        if p == "/api/group/create":
            d = self._body()
            name = str(d.get("name") or "").strip()[:24] or "群聊"
            members = [str(x) for x in (d.get("members") or [])
                       if str(x) and str(x) != ME["id"]]
            if not members:
                return self._json({"ok": False, "error": "至少选一个好友"}, 400)
            gid = new_id("g-")
            g = {
                "id": gid, "name": name, "owner": ME["id"],
                "members": members,
                "avatarKey": avatar_key(d.get("avatarKey"), "group"),
                "createdAt": now_ms(), "updatedAt": now_ms(),
            }
            GROUPS[gid] = g
            save_groups()
            gv = group_view(g)
            sent, failed = fanout_group(g, "/api/group/sync",
                                        {"group": gv, "from": ME["id"]})
            refresh()
            return self._json({"ok": True, "group": gv, "sent": sent, "failed": failed})

        if p == "/api/group/edit":
            d = self._body()
            gid = d.get("id")
            g = GROUPS.get(gid)
            if not g:
                return self._json({"ok": False, "error": "群不存在"}, 404)
            if d.get("name"):
                g["name"] = str(d["name"]).strip()[:24]
            if d.get("avatarKey") in (*AVATAR_KEYS, "group"):
                g["avatarKey"] = d["avatarKey"]
            removed = []
            if isinstance(d.get("members"), list):
                new_members = [str(x) for x in d["members"] if str(x) and str(x) != ME["id"]]
                removed = [m for m in g.get("members", []) if m not in new_members]
                g["members"] = new_members
            g["updatedAt"] = now_ms()
            save_groups()
            gv = group_view(g)
            fanout_group(g, "/api/group/sync",
                         {"group": gv, "from": ME["id"], "removed": removed})
            for rid in removed:          # 被移出的人也要知道
                p2 = PEERS.get(rid)
                if p2:
                    try:
                        post_to(p2, "/api/group/sync",
                                {"group": gv, "from": ME["id"], "removed": [rid]}, timeout=3)
                    except Exception:
                        pass
            refresh()
            return self._json({"ok": True, "group": gv})

        # 群主/管理员：踢人
        if p == "/api/group/kick":
            d = self._body()
            gid, target = d.get("id"), str(d.get("peerId") or "")
            g = GROUPS.get(gid)
            if not g:
                return self._json({"ok": False, "error": "群不存在"}, 404)
            me = ME["id"]
            is_owner = g.get("owner") == me
            is_admin = me in (g.get("admins") or [])
            if not (is_owner or is_admin):
                return self._json({"ok": False, "error": "只有群主/管理员能踢人"}, 403)
            if target == g.get("owner"):
                return self._json({"ok": False, "error": "不能移出群主"}, 403)
            if is_admin and not is_owner and target in (g.get("admins") or []):
                return self._json({"ok": False, "error": "管理员不能移出其他管理员"}, 403)
            g["members"] = [m for m in g.get("members", []) if m != target]
            g["admins"] = [a for a in g.get("admins", []) if a != target]
            g["updatedAt"] = now_ms()
            save_groups()
            gv = group_view(g)
            fanout_group(g, "/api/group/sync", {"group": gv, "from": me, "removed": [target]})
            tp = PEERS.get(target)
            if tp:                      # 被踢的人也要收到通知
                try:
                    post_to(tp, "/api/group/sync",
                            {"group": gv, "from": me, "removed": [target]}, timeout=3)
                except Exception:
                    pass
            refresh()
            return self._json({"ok": True, "group": gv})

        # 群主：设/撤管理员
        if p == "/api/group/setrole":
            d = self._body()
            gid, target = d.get("id"), str(d.get("peerId") or "")
            g = GROUPS.get(gid)
            if not g:
                return self._json({"ok": False, "error": "群不存在"}, 404)
            if g.get("owner") != ME["id"]:
                return self._json({"ok": False, "error": "只有群主能设置管理员"}, 403)
            admins = [a for a in (g.get("admins") or []) if a != target]
            if d.get("admin"):
                if target not in (g.get("members") or []):
                    return self._json({"ok": False, "error": "对方不在群里"}, 400)
                admins.append(target)
            g["admins"] = admins
            g["updatedAt"] = now_ms()
            save_groups()
            gv = group_view(g)
            fanout_group(g, "/api/group/sync", {"group": gv, "from": ME["id"]})
            refresh()
            return self._json({"ok": True, "group": gv})

        # 群主：解散群聊
        if p == "/api/group/dissolve":
            gid = self._body().get("id")
            g = GROUPS.get(gid)
            if not g:
                return self._json({"ok": False, "error": "群不存在"}, 404)
            if g.get("owner") != ME["id"]:
                return self._json({"ok": False, "error": "只有群主能解散"}, 403)
            fanout_group(g, "/api/group/sync",
                         {"group": {"id": gid}, "from": ME["id"], "dissolved": True})
            GROUPS.pop(gid, None)
            save_groups()
            refresh()
            return self._json({"ok": True})

        if p == "/api/group/leave":
            gid = self._body().get("id")
            g = GROUPS.pop(gid, None)
            if not g:
                return self._json({"ok": False, "error": "群不存在"}, 404)
            save_groups()
            fanout_group(g, "/api/group/sync",
                         {"group": group_view(g), "from": ME["id"],
                          "removed": [ME["id"]]})
            refresh()
            return self._json({"ok": True})

        # 节点间：群资料同步（建群 / 改名 / 加人 / 移人 / 退群）
        if p == "/api/group/sync":
            d = self._body()
            incoming = d.get("group") or {}
            gid = incoming.get("id")
            removed = d.get("removed") or []
            if d.get("dissolved"):
                if gid in GROUPS:
                    GROUPS.pop(gid, None)
                    save_groups()
                    refresh()
                return self._json({"ok": True, "dissolved": True})
            if gid and ME["id"] in removed and ME["id"] != d.get("from"):
                GROUPS.pop(gid, None)
                save_groups()
                refresh()
                return self._json({"ok": True, "left": True})
            # 只接受「拉我进群」的同步：新群必须把我列进 members，否则是别人的群
            me = ME["id"]
            invited = me in (incoming.get("members") or []) or me == incoming.get("owner")
            if gid not in GROUPS and not invited:
                return self._json({"ok": False, "error": "not a member"}, 403)
            g = upsert_group(incoming, sender=d.get("from"), removed=removed)
            return self._json({"ok": bool(g)})

        # 本地 UI：发群消息（先落自己的库，再扇出给成员）
        if p == "/api/group/send":
            return self._api_group_send(self._body())

        # 节点间：收到群消息
        if p == "/api/group/message":
            d = self._body()
            gid = d.get("groupId")
            msg = dict(d.get("msg") or {})
            if not gid or not msg:
                return self._json({"ok": False, "error": "bad payload"}, 400)
            if d.get("group"):
                upsert_group(d["group"], sender=msg.get("from"))
            msg["dir"] = "in"
            msg.setdefault("time", now_ms())
            add_message(gid, msg)
            return self._json({"ok": True})

        # These actions are initiated by this computer's desktop/web UI only.
        if p in ("/api/peer/ping", "/api/peer/diagnose", "/api/transfer/send-file",
                 "/api/transfer/retry", "/api/transfer/pause", "/api/transfer/cancel",
                 "/api/transfer/clear-done") and not ipaddress.ip_address(self.client_address[0]).is_loopback:
            return self._json({"ok": False, "error": "请在本机近传中使用此功能"}, 403)

        if p in ("/api/peer/ping", "/api/peer/diagnose"):
            return self._json(diagnose_peer(self._body()))

        if p == "/api/transfer/send-file":
            try:
                return self._json({"ok": True, "task": start_outbox(self._body())})
            except TransferError as e:
                return self._json({"ok": False, "error": str(e)}, e.status)

        if p in ("/api/transfer/retry", "/api/transfer/pause", "/api/transfer/cancel"):
            try:
                action = p.rsplit("/", 1)[-1]
                return self._json({"ok": True, "task": control_outbox(self._body().get("id"), action)})
            except TransferError as e:
                return self._json({"ok": False, "error": str(e)}, e.status)

        if p == "/api/transfer/clear-done":
            with OUTBOX_LOCK, FILE_LOCK:
                for task in OUTBOX.values():
                    if task["status"] in ("done", "canceled") and not task.get("dismissed"):
                        record = dict(task, dismissed=True)
                        write_record(outbox_record(task["id"]), record)
                        task["dismissed"] = True
                for tid, task in list(TRANSFERS.items()):
                    if task["status"] in ("done", "canceled"):
                        del TRANSFERS[tid]
            refresh()
            return self._json({"ok": True})

        if p.startswith("/api/file/resume/"):
            return self._api_resume(p.rsplit("/", 1)[-1], q)

        # 本地 UI：修改我的资料
        if p == "/api/config":
            d = self._body()
            profile_changed = apply_profile_fields(d)
            if "manual_peers" in d and isinstance(d["manual_peers"], list):
                CONFIG["manual_peers"] = d["manual_peers"]
            save_json(CONFIG_FILE, CONFIG)
            if profile_changed:
                threading.Thread(target=announce_profile_to_peers, daemon=True).start()
            refresh()
            return self._json({"ok": True, "me": dict(ME)})

        if p.startswith("/api/cache/") or p == "/api/transfer/forward":
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                self.close_connection = True
                return self._json({"ok": False, "error": "此操作只接受本机程序调用"}, 403)
            if p == "/api/transfer/forward":
                return self._api_legacy_forward(self._body())
            return self._api_local_cache(p.rsplit("/", 1)[-1], q)

        # 本地 UI：缓存一份即将发送的文件，供自己这边的聊天气泡持久显示
        if p == "/api/cache":
            return self._api_cache(q)

        # 节点间：接收文件流（真正的传输进度在这里统计）
        if p == "/api/file/upload":
            return self._api_file_upload(q)

        # 本地 UI：登记一个「发送中」任务（前端 XHR 会持续更新进度）
        if p == "/api/transfer/upsert":
            t = self._body()
            tid = t.get("id") or new_id("t-")
            with FILE_LOCK:
                TRANSFERS[tid] = t
            push_progress(TRANSFERS[tid])
            return self._json({"ok": True, "id": tid})

        if p == "/api/transfer/remove":
            tid = self._body().get("id")
            with FILE_LOCK:
                TRANSFERS.pop(tid, None)
            return self._json({"ok": True})

        if p == "/api/clear":
            pid = self._body().get("id")
            with FILE_LOCK:
                MESSAGES.pop(pid, None)
                save_messages()
            refresh()
            return self._json({"ok": True})

        # ---------------- 桌面体验（QQ 式） ----------------

        # 本地 UI：标记某好友已读（清除未读角标，同时更新托盘/悬浮窗）
        if p == "/api/read":
            d = self._body()
            pid = d.get("id", "")
            if not isinstance(pid, str):
                return self._json({"ok": False, "error": "会话编号无效"}, 400)
            with FILE_LOCK:
                last = next((m.get("msgId") for m in reversed(MESSAGES.get(pid, ()))
                             if m.get("dir") == "in"), None)
                if "through" in d and last != d["through"]:
                    return self._json({"ok": True, "stale": True})
                changed = UNREAD.pop(pid, None)
            if changed:
                refresh()
            if DESKTOP and changed:
                try:
                    DESKTOP.on_unread()
                except Exception:
                    pass
            return self._json({"ok": True})

        # ---------------- 在线更新 ----------------
        if p == "/api/update/download":
            d = self._body()
            url = str(d.get("url") or "")
            if not url.startswith("http"):
                return self._json({"ok": False, "error": "缺少下载地址"}, 400)
            ok, attached = start_update_download(url, d.get("name") or "JinChuan.exe",
                                                 d.get("size") or 0)
            if not ok:
                return self._json({"ok": False, "error": "下载启动失败"}, 400)
            with UPDATE_LOCK:
                snap = dict(UPDATE)
            return self._json({"ok": True, "attached": attached, "state": snap})

        if p == "/api/update/cancel":
            was = cancel_update_download()
            return self._json({"ok": True, "cancelled": was})

        if p == "/api/update/apply":
            dry = q.get("dry", ["0"])[0] == "1"
            ok, msg, script = apply_update(dry_run=dry)
            if dry:
                return self._json({"ok": ok, "message": msg,
                                   "script": str(script) if script else ""})
            if not ok:
                return self._json({"ok": False, "error": msg}, 400)

            def _bye():                     # 先把响应发回去，再退出让脚本替换 exe
                time.sleep(0.5)
                if DESKTOP:
                    try:
                        DESKTOP.quit_app()
                        return
                    except Exception:
                        pass
                os._exit(0)
            threading.Thread(target=_bye, daemon=True).start()
            return self._json({"ok": True, "message": msg})

        # 本地 UI：设置（接收目录 / 通知 / 关到托盘 / 自启 / 外观 / 资料）
        if p == "/api/settings":
            d = self._body()
            global DOWNLOAD_DIR, UPDATE_CACHE
            # 自启先做：失败就别改任何配置，返回明确原因给界面
            if "autostart" in d:
                ok, text = set_autostart(bool(d["autostart"]))
                if not ok:
                    return self._json({"ok": False, "error": text}, 400)
                CONFIG["autostart"] = bool(d["autostart"])
            if "download_dir" in d:
                v = str(d["download_dir"]).strip()
                if v:
                    nd = Path(v).expanduser()
                    if not nd.is_absolute():
                        return self._json({"ok": False, "error": "请填写绝对路径"}, 400)
                    try:
                        nd.mkdir(parents=True, exist_ok=True)
                    except Exception as e:
                        return self._json({"ok": False, "error": "无法创建目录: " + str(e)}, 400)
                    CONFIG["download_dir"] = str(nd)
                    DOWNLOAD_DIR = nd
                else:
                    CONFIG["download_dir"] = ""
                    DOWNLOAD_DIR = DATA_DIR / "downloads"
                    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
            for k in ("notify", "close_to_tray", "dnd", "sound"):
                if k in d:
                    CONFIG[k] = bool(d[k])
            if d.get("theme") in ("light", "dark", "auto"):
                CONFIG["theme"] = d["theme"]
            if d.get("motion") in ("full", "reduced"):
                CONFIG["motion"] = d["motion"]
            if "update_repo" in d:
                repo = str(d["update_repo"]).strip().strip("/")[:120]
                if repo != CONFIG.get("update_repo"):
                    CONFIG["update_repo"] = repo
                    UPDATE_CACHE = (0.0, None)      # 换了仓库要重新检查
            profile_changed = apply_profile_fields(d)
            new_peers = []
            if "manual_peers" in d and isinstance(d["manual_peers"], list):
                CONFIG["manual_peers"] = [str(x).strip() for x in d["manual_peers"]
                                          if str(x).strip()]
                new_peers = list(CONFIG["manual_peers"])
            save_json(CONFIG_FILE, CONFIG)
            if profile_changed:
                threading.Thread(target=announce_profile_to_peers, daemon=True).start()
            # 新写的固定地址立刻尝试连接，不用等下一轮发现
            if new_peers:
                def _probe(addrs):
                    for a in addrs:
                        try:
                            register_addr(a, retry=1)
                        except Exception:
                            pass
                threading.Thread(target=_probe, args=(new_peers,), daemon=True).start()
            if DESKTOP:
                try:
                    DESKTOP.on_settings(dict(CONFIG))
                except Exception:
                    pass
            refresh()
            return self._json({"ok": True, "me": dict(ME),
                               "downloadDir": str(DOWNLOAD_DIR)})

        # 本地 UI：截屏（桌面版，PIL.ImageGrab）
        if p == "/api/screenshot":
            if not DESKTOP:
                return self._json({"ok": False, "error": "仅桌面版支持截屏"}, 400)
            path = DESKTOP.screenshot()
            if not path:
                return self._json({"ok": False, "error": "截屏失败"}, 500)
            return self._json({"ok": True, "path": path})

        # 本地 UI：另存为（原生保存对话框，桌面版）
        if p == "/api/save-as":
            d = self._body()
            if not DESKTOP:
                return self._json({"ok": False, "fallback": True}, 400)
            saved = DESKTOP.save_as(d.get("path", ""), d.get("name", "file"))
            return self._json({"ok": bool(saved), "saved": saved or ""})

        # 本地 UI：选择接收文件夹（原生目录对话框，桌面版）
        if p == "/api/choose-folder":
            if not DESKTOP:
                return self._json({"ok": False}, 400)
            folder = DESKTOP.choose_folder()
            return self._json({"ok": bool(folder), "folder": folder or ""})

        # 本地 UI：打开接收文件夹
        if p == "/api/open-folder":
            d = self._body()
            target = d.get("path") or ""
            if not target:
                target = str(DOWNLOAD_DIR)
            elif not Path(target).is_absolute():
                # 允许传相对 data 的路径（如 downloads/某文件夹）
                target = resolve_media_path(target)
                if target is None:
                    return self._json({"ok": False}, 404)
            return self._json({"ok": open_in_explorer(target)})

        # 本地 UI：窗口控制（最小化 / 隐藏到托盘 / 显示 / 退出 / 悬浮窗 / 焦点状态）
        if p == "/api/desktop":
            d = self._body()
            if not DESKTOP:
                return self._json({"ok": False, "desktop": False}, 400)
            DESKTOP.control(d.get("action", ""), d.get("value"))
            return self._json({"ok": True, "desktop": True})

        return self._respond(404, "Not Found", "text/plain; charset=utf-8")

    def _api_send(self, d):
        pid = d.get("to")
        mid = d.get("msgId") or new_id("m-")
        with FILE_LOCK:
            peer = dict(PEERS.get(pid, {}))
        out = {
            "msgId": mid, "dir": "out",
            "type": d.get("type", "text"),
            "text": d.get("text", ""),
            "fileName": d.get("fileName", ""),
            "size": d.get("size", 0),
            "media": d.get("media", ""),
            "reply": d.get("reply") or None,
            "time": d.get("time") or now_ms(),
            "status": "sending"
        }
        if peer:
            payload = {
                "msgId": mid, "from": ME["id"], "fromName": ME["name"], "fromAvatarKey": ME["avatarKey"],
                "type": out["type"], "text": out["text"],
                "fileName": out["fileName"], "size": out["size"],
                "media": d.get("peerMedia") or out["media"],
                "reply": d.get("reply") or None,
                "time": out["time"]
            }
            # 对方已离线就别让界面干等 5 秒：先用短超时试一下，失败立刻标记
            online = time.time() - peer.get("last_seen", 0) < PEER_TIMEOUT
            try:
                status, _ = post_to(peer, "/api/message", payload,
                                    timeout=5 if online else 1.5)
                out["status"] = "done" if status == 200 else "failed"
            except Exception:
                out["status"] = "failed"
        else:
            out["status"] = "failed"
        add_message(pid, out)
        return self._json({"ok": out["status"] != "failed", "status": out["status"]})

    def _api_group_send(self, d):
        """本地发群消息：先落自己的库，再扇出给每个在线成员。"""
        gid = d.get("groupId")
        g = GROUPS.get(gid)
        if not g:
            return self._json({"ok": False, "error": "群不存在"}, 404)
        mid = d.get("msgId") or new_id("m-")
        out = {
            "msgId": mid, "dir": "out", "from": ME["id"], "fromName": ME["name"], "fromAvatarKey": ME["avatarKey"],
            "type": d.get("type", "text"), "text": d.get("text", ""),
            "fileName": d.get("fileName", ""), "size": d.get("size", 0),
            "media": d.get("media", ""), "reply": d.get("reply") or None,
            "time": d.get("time") or now_ms(), "status": "sending",
        }
        payload = {
            "groupId": gid, "group": group_view(g),
            "msg": {
                "msgId": mid, "from": ME["id"], "fromName": ME["name"], "fromAvatarKey": ME["avatarKey"],
                "type": out["type"], "text": out["text"],
                "fileName": out["fileName"], "size": out["size"],
                "media": d.get("peerMedia") or out["media"],
                "reply": out["reply"], "time": out["time"],
            },
        }
        media_by_peer = d.get("peerMediaById")
        if not isinstance(media_by_peer, dict):
            media_by_peer = None
        sent, failed = fanout_group(g, "/api/group/message", payload, media_by_peer=media_by_peer)
        out["status"] = "done" if sent else "failed"
        add_message(gid, out)
        g["updatedAt"] = now_ms()
        save_groups()
        return self._json({"ok": sent > 0, "status": out["status"],
                           "sent": sent, "failed": failed})

    def _api_local_cache(self, action, q):
        try:
            if action == "append":
                self.connection.settimeout(30)
                try:
                    offset = int(q.get("offset", ["-1"])[0])
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError as exc:
                    raise TransferError("文件分块参数无效") from exc
                return self._json(LOCAL_CACHE.append(q.get("id", [""])[0], offset, length, self.rfile))
            d = self._body()
            if action == "start":
                name = Path(safe_rel(str(d.get("name") or "文件"))).name
                return self._json(LOCAL_CACHE.start(name, d.get("size"), d.get("temporary") is True))
            if action == "finish":
                return self._json(LOCAL_CACHE.finish(d.get("id")))
            if action == "discard":
                LOCAL_CACHE.discard(d.get("id"))
                return self._json({"ok": True})
            raise TransferError("未知本机缓存操作", 404)
        except TransferError as e:
            self.close_connection = True
            return self._json({"ok": False, "error": str(e)}, e.status)
        except OSError as e:
            self.close_connection = True
            print("[local file cache]", e)
            return self._json({"ok": False, "error": "写入本机缓存失败，请检查数据盘空间和权限。"}, 500)

    def _api_legacy_forward(self, d):
        """Legacy receiver protocol, without a cross-origin or whole-File request in WebView."""
        pid = d.get("peerId")
        with FILE_LOCK:
            peer = dict(PEERS.get(pid, {})) if isinstance(pid, str) else {}
        if not peer:
            return self._json({"ok": False, "error": "会话设备已移除"}, 404)
        try:
            if d.get("stageId"):
                stream, size = LOCAL_CACHE.open_temporary(d["stageId"])
            else:
                path = resolve_media_path(d.get("path"))
                if not path or CACHE_DIR.resolve() not in path.parents or not path.is_file():
                    raise TransferError("找不到本机文件缓存", 404)
                stream = path.open("rb")
                size = path.stat().st_size
        except (TransferError, OSError) as e:
            return self._json({"ok": False, "error": str(e)}, 400)

        tid = str(d.get("id") or new_id("t-"))
        extra = {key:d[key] for key in ("folder","idx","count","total","silent") if key in d}
        query = urllib.parse.urlencode(dict(id=tid, msgId=str(d.get("msgId") or new_id("m-")),
            name=str(d.get("name") or "文件"), rel=str(d.get("rel") or d.get("name") or "文件"),
            size=size, kind="image" if d.get("kind") == "image" else "file",
            time=d.get("time") or now_ms(), **{"from":ME["id"],"fromName":ME["name"]}, **extra))

        class UploadStream:
            offset = 0
            last = time.monotonic()
            previous = 0

            def read(self, count):
                data = stream.read(count)
                self.offset += len(data)
                now = time.monotonic()
                if data and now - self.last >= 0.3:
                    broadcast({"type":"forward-progress","id":tid,"bytes":self.offset,
                               "speed":int((self.offset - self.previous)/(now - self.last))})
                    self.previous, self.last = self.offset, now
                return data

        conn = http.client.HTTPConnection(peer["ip"], int(peer["http"]), timeout=45, blocksize=CHUNK)
        try:
            with stream:
                try:
                    conn.request("POST", "/api/file/upload?" + query, body=UploadStream(),
                                 headers={"Content-Type":"application/octet-stream","Content-Length":str(size)})
                except (BrokenPipeError, ConnectionResetError) as interrupted:
                    # The receiver can send an error and close early, before all bytes are written.
                    try:
                        reply = conn.getresponse()
                    except (OSError, http.client.HTTPException):
                        raise interrupted
                else:
                    reply = conn.getresponse()
                try:
                    result = json.loads(reply.read(32768))
                except ValueError:
                    result = {}
                if not isinstance(result, dict) or not 200 <= reply.status < 300 or not result.get("ok"):
                    detail = result.get("error") if isinstance(result, dict) else None
                    if detail and ("relative" in detail or "subpath" in detail):
                        detail = "对方旧版无法写入自定义接收目录，请更新接收端或检查其接收设置。"
                    return self._json({"ok": False, "error": detail or f"接收端拒收（HTTP {reply.status}）"}, 502)
                return self._json({"ok": True, "path": result.get("path", "")})
        except ConnectionRefusedError:
            return self._json({"ok": False, "error": "对方的传输入口拒绝连接，请确认近传仍在运行。"}, 502)
        except TimeoutError:
            return self._json({"ok": False, "error": "发送文件超时，请检查双方连接和接收端磁盘。"}, 504)
        except (OSError, http.client.HTTPException) as e:
            print("[legacy file forward]", e)
            return self._json({"ok": False, "error": "连接在发送数据时中断，诊断通过不代表文件已送达。"}, 502)
        finally:
            conn.close()

    def _api_cache(self, q):
        name = q.get("name", ["file"])[0]
        n = int(self.headers.get("Content-Length") or 0)
        with FILE_LOCK:
            f = unique_path(CACHE_DIR / Path(safe_rel(name)).name)
            f.parent.mkdir(parents=True, exist_ok=True)
            out = f.open("xb")
        sha = hashlib.sha256()
        try:
            with out:
                remaining = n
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise OSError("文件缓存未收齐")
                    out.write(chunk)
                    sha.update(chunk)
                    remaining -= len(chunk)
        except OSError as e:
            f.unlink(missing_ok=True)
            return self._json({"ok": False, "error": str(e)}, 500)
        return self._json({"ok": True, "path": f.relative_to(DATA_DIR).as_posix(),
                           "size": n, "sha256": sha.hexdigest()})

    def _api_resume(self, action, q):
        try:
            if action == "append":
                source = q.get("from", [""])[0]
                check_resume_peer(source, self.client_address[0])
                self.connection.settimeout(15)
                try:
                    offset = int(q.get("offset", ["-1"])[0])
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError as exc:
                    raise TransferError("分块偏移无效") from exc
                tid = q.get("id", [""])[0]
                result, _ = RESUME_STORE.append(source, tid, offset, length, self.rfile, receive_progress)
                return self._json(result)
            d = self._body()
            source = d.get("from", "")
            check_resume_peer(source, self.client_address[0])
            if action == "status":
                if not isinstance(d.get("name"), str) or not isinstance(d.get("msgId"), str) or not d["msgId"]:
                    raise TransferError("缺少文件或消息信息")
                result = RESUME_STORE.status({
                    "from": source, "id": d.get("id"), "name": Path(safe_rel(d["name"])).name,
                    "size": d.get("size"), "sha256": d.get("sha256"),
                    "msgId": str(d.get("msgId") or "")[:96], "kind": "image" if d.get("kind") == "image" else "file",
                    "time": d.get("time") if type(d.get("time")) is int else now_ms(),
                    "reply": d.get("reply") if isinstance(d.get("reply"), dict) else None,
                }, receive_progress)
                return self._json(result)
            if action == "finish":
                return self._json(RESUME_STORE.finish(source, d.get("id"), finish_inbox, receive_progress))
            if action in ("pause", "cancel"):
                return self._json(RESUME_STORE.control(source, d.get("id"), action, finish_inbox, receive_progress))
            raise TransferError("未知文件操作", 404)
        except TransferError as e:
            return self._json({"ok": False, "error": str(e), **e.detail}, e.status)
        except OSError as e:
            return self._json({"ok": False, "error": "接收文件中断：" + str(e)}, 500)

    def _api_file_upload(self, q):
        """接收文件流。folder=1 时按批次累计，整个文件夹只产生一条消息、一个总进度。"""
        n = int(self.headers.get("Content-Length") or 0)
        name = q.get("name", ["received_file"])[0]
        rel = safe_rel(q.get("rel", [name])[0] or name)
        size = int(q.get("size", [n])[0] or n)
        tid = q.get("id", [new_id("t-")])[0]
        mid = q.get("msgId", [new_id("m-")])[0]
        from_id = q.get("from", [""])[0]
        kind = q.get("kind", ["file"])[0]
        t = q.get("time", [str(now_ms())])[0]
        from_name = q.get("fromName", ["好友"])[0]

        folder_mode = q.get("folder", ["0"])[0] == "1"
        idx = int(q.get("idx", ["0"])[0] or 0)
        count = max(1, int(q.get("count", ["1"])[0] or 1))
        total = int(q.get("total", [str(size)])[0] or size)
        parts = rel.split("/")
        if n != size or size < 0 or (folder_mode and (len(parts) < 2 or idx < 0 or idx >= count or total < size)):
            self.close_connection = True
            return self._json({"ok": False, "error": "文件大小或目录批次参数无效"}, 400)

        with FILE_LOCK:
            task = TRANSFERS.get(tid) if folder_mode else None

        if folder_mode and task is None:
            if idx != 0:
                self.close_connection = True
                return self._json({"ok": False, "error": "找不到文件夹批次，请从头发送。"}, 409)
            # 文件夹批次：第一层目录名作为目标根目录（同名自动加序号）
            try:
                with FILE_LOCK:
                    root = unique_path(DOWNLOAD_DIR / parts[0])
                    root.mkdir(parents=True)
                    ref = received_reference(root)
            except OSError as e:
                print("[receive folder]", e)
                self.close_connection = True
                return self._json({"ok": False, "error": "接收端无法创建目录，请检查保存位置和权限。"}, 500)
            task = {
                "id": tid, "direction": "in", "peerId": from_id,
                "name": parts[0], "rel": rel, "size": total, "kind": "folder",
                "fileCount": count, "filesDone": 0,
                "doneBytes": 0, "speed": 0, "status": "running",
                "start": time.time(), "msgId": mid,
                "rootDir": str(root),
                "path": ref
            }
            with FILE_LOCK:
                TRANSFERS[tid] = task
            push_progress(task)
            target = root / Path(*parts[1:]) if len(parts) > 1 else root / parts[0]
        elif folder_mode:
            if task.get("status") != "running" or task.get("filesDone") != idx or task.get("peerId") != from_id:
                self.close_connection = True
                return self._json({"ok": False, "error": "文件夹批次已中断，请重新发送。"}, 409)
            root = Path(task["rootDir"])
            target = root / Path(*parts[1:]) if len(parts) > 1 else root / parts[0]
        else:
            try:
                with FILE_LOCK:
                    target = unique_path(DOWNLOAD_DIR / rel)
                    ref = received_reference(target)
            except OSError as e:
                print("[receive file location]", e)
                self.close_connection = True
                return self._json({"ok": False, "error": "接收端存储路径不可用。"}, 500)
            task = {
                "id": tid, "direction": "in", "peerId": from_id,
                "name": name, "rel": rel, "size": size,
                "doneBytes": 0, "speed": 0, "status": "running",
                "start": time.time(), "msgId": mid,
                "path": ref
            }
            with FILE_LOCK:
                TRANSFERS[tid] = task
            push_progress(task)

        remaining = n
        last = time.time()
        last_bytes = int(task.get("doneBytes", 0))
        err = None
        created = False
        try:
            self.connection.settimeout(45)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as out:
                created = True
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise IOError("连接提前中断")
                    out.write(chunk)
                    remaining -= len(chunk)
                    task["doneBytes"] += len(chunk)
                    now = time.time()
                    if now - last >= 0.15:
                        dt = now - last
                        task["speed"] = (task["doneBytes"] - last_bytes) / dt if dt else 0
                        last, last_bytes = now, task["doneBytes"]
                        push_progress(task)
        except Exception as e:
            err = str(e)

        if err:
            self.close_connection = True
            if created:
                try:
                    target.unlink(missing_ok=True)
                except OSError as e:
                    print("[cleanup incomplete upload]", e)
            task["status"] = "error"
            task["error"] = err
            push_progress(task)
            return self._json({"ok": False, "error": err}, 500)

        if folder_mode:
            task["filesDone"] = int(task.get("filesDone", 0)) + 1
            last_file = task["filesDone"] >= count
            if not last_file:
                task["speed"] = 0
                push_progress(task)
                return self._json({"ok": True, "path": task["path"], "id": tid,
                                   "partial": True})
            task["status"] = "done"
            task["doneBytes"] = task["size"]
            task["speed"] = 0
            push_progress(task)
            add_message(from_id, {
                "msgId": mid, "dir": "in", "type": "folder",
                "text": "", "fileName": task["name"], "size": task["size"],
                "fileCount": count, "folderPath": task["path"],
                "media": "", "time": int(t), "status": "done"
            })
            broadcast({"type": "toast", "from": from_name,
                       "text": "发来文件夹 {}（{} 个文件）".format(task["name"], count)})
            return self._json({"ok": True, "path": task["path"], "id": tid})

        task["status"] = "done"
        task["doneBytes"] = task["size"]
        task["speed"] = 0
        push_progress(task)

        # 群文件：每个成员各收一份，但不在单聊里生成消息（silent=1），
        # 由发起方另外发一条群消息，大家在群里看到同一个气泡。
        if q.get("silent", ["0"])[0] == "1":
            return self._json({"ok": True, "path": task["path"], "id": tid, "silent": True})

        add_message(from_id, {
            "msgId": mid, "dir": "in",
            "type": "image" if kind == "image" else "file",
            "text": "", "fileName": name, "size": size,
            "media": task["path"], "time": int(t), "status": "done"
        })
        broadcast({"type": "toast", "from": from_name,
                   "text": "发来文件 {}".format(name)})
        return self._json({"ok": True, "path": task["path"], "id": tid})


# ----------------------------------------------------------------------------
# 小游戏：房间 + 斗地主（房主进程当裁判，其余人轮询状态）
#   牌值：3..15 表示 3..A，16 小王，17 大王
#   房主进来的人都可以是真人；空缺位置由简单的托管机器人补上
# ----------------------------------------------------------------------------
GAMES = {}                 # roomId -> 房间状态
GAME_LOCK = threading.RLock()
DDZ_VALUES = list(range(3, 16))


def ddz_deck():
    cards = []
    for v in DDZ_VALUES:
        cards.extend([v] * 4)
    cards.extend([16, 17])
    return cards


def ddz_type(cards):
    """识别牌型，返回 (kind, main_value, length) 或 None。"""
    if not cards:
        return None
    c = sorted(cards)
    n = len(c)
    cnt = Counter(c)
    vals = sorted(cnt)
    if n == 2 and c == [16, 17]:
        return ("rocket", 100, 1)
    if n == 4 and len(cnt) == 1:
        return ("bomb", c[0], 1)
    if n == 1:
        return ("single", c[0], 1)
    if n == 2 and len(cnt) == 1:
        return ("pair", c[0], 1)
    if n == 3 and len(cnt) == 1:
        return ("triple", c[0], 1)
    if n == 4 and len(cnt) == 2 and 3 in cnt.values():
        return ("triple1", max(cnt, key=lambda k: cnt[k]), 1)
    if n == 5 and len(cnt) == 2 and sorted(cnt.values()) == [2, 3]:
        return ("triple2", max(cnt, key=lambda k: cnt[k]), 1)
    if n >= 5 and len(cnt) == 1 and c[-1] <= 14 and c[-1] - c[0] == n - 1:
        return ("straight", c[0], n)
    if (n >= 6 and n % 2 == 0 and len(cnt) >= 3 and all(v == 2 for v in cnt.values())
            and vals[-1] <= 14 and vals[-1] - vals[0] == len(vals) - 1):
        return ("pairs", vals[0], len(vals))
    if (n >= 6 and n % 3 == 0 and len(cnt) >= 2 and all(v == 3 for v in cnt.values())
            and vals[-1] <= 14 and vals[-1] - vals[0] == len(vals) - 1):
        return ("plane", vals[0], len(vals))
    return None


def ddz_beats(a, b):
    """a 能不能压 b（b 为 None 表示自由出牌）。"""
    if not a:
        return False
    if not b:
        return True
    if a[0] == "rocket":
        return True
    if b[0] == "rocket":
        return False
    if a[0] == "bomb" and b[0] != "bomb":
        return True
    if b[0] == "bomb" and a[0] != "bomb":
        return False
    if a[0] != b[0]:
        return False
    if a[0] in ("straight", "pairs", "plane") and a[2] != b[2]:
        return False
    return a[1] > b[1]


def ddz_new_room(host_id, host_name, game="ddz"):
    rid = new_id("r-")
    room = {
        "id": rid, "game": game, "host": host_id, "phase": "waiting",
        "players": [{"id": host_id, "name": host_name, "seat": 0, "bot": False}],
        "hands": {}, "bottom": [], "landlord": None, "turn": 0,
        "last": None, "passes": 0, "winner": None, "log": [],
        "createdAt": now_ms(), "updatedAt": now_ms(),
    }
    with GAME_LOCK:
        GAMES[rid] = room
    return room


def ddz_fill_bots(room):
    """不足 3 人就用托管机器人补位，方便两个人甚至一个人试玩。"""
    names = ["机器人·小北", "机器人·小南"]
    i = 0
    while len(room["players"]) < 3:
        room["players"].append({"id": "bot-%d" % (i + 1), "name": names[i % len(names)],
                                "seat": len(room["players"]), "bot": True})
        i += 1


def ddz_start(room):
    ddz_fill_bots(room)
    deck = ddz_deck()
    random.shuffle(deck)
    seats = [p["seat"] for p in room["players"]]
    hands = {s: sorted(deck[s * 17:(s + 1) * 17]) for s in seats}
    room["hands"] = hands
    room["bottom"] = sorted(deck[51:54])
    room["phase"] = "bid"
    room["turn"] = random.choice(seats)
    room["landlord"] = None
    room["last"] = None
    room["passes"] = 0
    room["winner"] = None
    room["bid_passed"] = []
    room["bid"] = {"high": 0, "who": None, "acted": []}   # 叫分：1/2/3 分，最高者当地主
    room["mult"] = 1                                       # 炸弹/王炸翻倍
    room["base"] = 1                                       # 底分 = 叫到的分
    room["result"] = None
    room["acts"] = {}
    room["acted_at"] = 0
    room["actions"] = {}
    room["played"] = []
    room["log"] = ["发牌完成，等待叫地主"]
    room["updatedAt"] = now_ms()


def ddz_take_bottom(room, seat):
    room["landlord"] = seat
    room["base"] = max(1, int((room.get("bid") or {}).get("high") or 1))
    room["acted_at"] = time.time()
    room["hands"][seat] = sorted(room["hands"][seat] + room["bottom"])
    room["phase"] = "play"
    room["turn"] = seat
    room["last"] = None
    room["passes"] = 0
    room["actions"] = {}
    name = next(p["name"] for p in room["players"] if p["seat"] == seat)
    room["log"].append("%s 当地主，拿到底牌" % name)
    room["updatedAt"] = now_ms()


def ddz_next_turn(room):
    seats = sorted(p["seat"] for p in room["players"])
    i = seats.index(room["turn"])
    room["turn"] = seats[(i + 1) % len(seats)]


def ddz_public(room, pid):
    with GAME_LOCK:
        me = next((p for p in room["players"] if p["id"] == pid), None)
        seat = me["seat"] if me else -1
        players = []
        for p in room["players"]:
            players.append({
                "id": p["id"], "name": p["name"], "seat": p["seat"], "bot": p["bot"],
                "count": len(room["hands"].get(p["seat"], [])),
                "landlord": room["landlord"] == p["seat"],
            })
        return {
            "ok": True, "id": room["id"], "game": room["game"], "phase": room["phase"],
            "seat": seat, "turn": room["turn"], "landlord": room["landlord"],
            "players": players,
            "hand": room["hands"].get(seat, []) if seat >= 0 else [],
            "bottom": room["bottom"] if room["phase"] != "bid" else [],
            "last": room["last"], "actions": room.get("actions") or {},
            "played": room.get("played") or [],
            "bid": room.get("bid") or {"high": 0, "who": None, "acted": []},
            "base": room.get("base") or 1, "mult": room.get("mult") or 1,
            "result": room.get("result"),
            "winner": room["winner"],
            "log": room["log"][-6:], "updatedAt": room["updatedAt"],
            "host": room["host"],
        }


def ddz_bot_move(room):
    """很朴素的托管：自由出牌出最小单张；能压就压最小的单/对/三；否则过。"""
    seat = room["turn"]
    hand = room["hands"].get(seat, [])
    if not hand:
        return
    last = room["last"]
    if room["phase"] == "bid":
        ddz_take_bottom(room, seat)
        return
    if not last:
        play = [hand[0]]
    else:
        target = last["type"]
        cnt = Counter(hand)
        play = None
        if target[0] in ("single", "pair", "triple"):
            need = {"single": 1, "pair": 2, "triple": 3}[target[0]]
            for v in sorted(cnt):
                if cnt[v] >= need and v > target[1]:
                    play = [v] * need
                    break
        if play is None:
            for v in sorted(cnt):
                if cnt[v] == 4:
                    play = [v] * 4
                    break
        if play is None and 16 in cnt and 17 in cnt:
            play = [16, 17]
    if play:
        ddz_play(room, seat, play)
    else:
        ddz_pass(room, seat)


def ddz_play(room, seat, cards):
    hand = room["hands"].get(seat, [])
    if any(cards.count(v) > hand.count(v) for v in set(cards)):
        return False, "手里没有这些牌"
    t = ddz_type(cards)
    if not t:
        return False, "牌型不对"
    last = room["last"]
    if last and last["seat"] != seat:
        if not ddz_beats(t, last["type"]):
            return False, "压不过上家"
    for v in cards:
        hand.remove(v)
    room["hands"][seat] = sorted(hand)
    room["last"] = {"seat": seat, "cards": sorted(cards), "type": t}
    room.setdefault("actions", {})[seat] = {"cards": sorted(cards), "pass": False}
    room.setdefault("played", []).extend(cards)
    room["acted_at"] = time.time()
    room.setdefault("plays", {})[seat] = room.setdefault("plays", {}).get(seat, 0) + 1
    if t[0] in ("bomb", "rocket"):
        room["mult"] = int(room.get("mult") or 1) * 2
    room["passes"] = 0
    name = next(p["name"] for p in room["players"] if p["seat"] == seat)
    room["log"].append("%s 出 %s" % (name, ",".join(ddz_label(c) for c in sorted(cards))))
    room["updatedAt"] = now_ms()
    if not hand:
        room["phase"] = "over"
        room["winner"] = "landlord" if room["landlord"] == seat else "farmer"
        base = int(room.get("base") or 1)
        mult = int(room.get("mult") or 1)
        plays = room.get("plays") or {}
        farmers = [x["seat"] for x in room["players"] if x["seat"] != room["landlord"]]
        if room["winner"] == "landlord" and all(plays.get(f, 0) == 0 for f in farmers):
            mult *= 2
            room["log"].append("春天，倍数翻倍")
        elif room["winner"] == "farmer" and plays.get(room["landlord"], 0) <= 1:
            mult *= 2
            room["log"].append("反春天，倍数翻倍")
        room["result"] = {"base": base, "mult": mult, "score": base * mult,
                          "winner": room["winner"]}
        room["log"].append(("地主赢了" if room["winner"] == "landlord" else "农民赢了")
                           + "（%d 分 × %d 倍 = %d）" % (base, mult, base * mult))
        return True, ""
    ddz_next_turn(room)
    return True, ""


def ddz_pass(room, seat):
    if not room["last"] or room["last"]["seat"] == seat:
        return False, "该你先出，不能过"
    room["passes"] += 1
    room["acted_at"] = time.time()
    room.setdefault("actions", {})[seat] = {"cards": [], "pass": True}
    name = next(p["name"] for p in room["players"] if p["seat"] == seat)
    room["log"].append("%s 不要" % name)
    room["updatedAt"] = now_ms()
    if room["passes"] >= 2:
        room["last"] = None
        room["actions"] = {}
        room["passes"] = 0
        room["log"].append("两家都不要，重新出牌")
    ddz_next_turn(room)
    return True, ""


def ddz_label(v):
    return {11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王"}.get(v, str(v))


def ddz_auto(room, pace=1.4):
    """机器人一拍一步：两次动作之间至少隔 pace 秒，让客户端能看到「谁出了什么」。

    以前是一次把所有机器人动作跑完，界面直接跳到结果，看着像没出牌。
    """
    now = time.time()
    if now - float(room.get("acted_at") or 0) < pace:
        return
    seat = room["turn"]
    p = next((x for x in room["players"] if x["seat"] == seat), None)
    if not p or not p.get("bot"):
        return
    if room["phase"] in ("bid", "play"):
        ddz_bot_move(room)
        room["acted_at"] = time.time()



# ----------------------------------------------------------------------------
# 川麻联机中继：房主浏览器跑引擎，其他人的动作经这里转给房主
#   POST /api/mj/relay/host   房主上报最新 view
#   POST /api/mj/relay/action 玩家提交动作
#   GET  /api/mj/relay        拉取 view + 新动作（since 游标）
# ----------------------------------------------------------------------------
MJ_RELAY = {}          # room -> {"view":..., "actions":[...], "seq":n}
MJ_RELAY_LOCK = threading.Lock()

# /ws/game 的房间表：room -> {WSClient}
GAME_ROOMS = {}
GAME_SEATS = {}      # room -> {seat: name}
GAME_HOSTS = {}      # room -> {id(client): True}（房主连接）
GAME_LOCK = threading.Lock()

def claim_game_seat(room, requested):
    """Called with GAME_LOCK held; selection and reservation share the same lock."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", room):
        return None, "ROOM_NOT_FOUND"
    seats = GAME_SEATS.get(room, {})
    if requested == "0":
        if GAME_HOSTS.get(room) or seats:
            return None, "SEAT_TAKEN"
        return 0, None
    if not GAME_HOSTS.get(room):
        return None, "ROOM_NOT_FOUND"
    if requested == "auto":
        seat = next((n for n in (1, 2, 3) if n not in seats), None)
        return (seat, None) if seat is not None else (None, "ROOM_FULL")
    if requested not in ("1", "2", "3"):
        return None, "INVALID_SEAT"
    seat = int(requested)
    return (None, "SEAT_TAKEN") if seat in seats else (seat, None)


def game_relay(room, obj, exclude=None):
    with GAME_LOCK:
        clients = list(GAME_ROOMS.get(room) or ())
    for c in clients:
        if c is not exclude:
            try:
                c.send(obj)
            except Exception:
                pass


HELP_TEXT = """近传 使用说明
1) 两台电脑连同一个局域网（同一 WiFi / 同一路由器）。
2) Windows 双击 近传.exe；源码方式双击 start.bat（macOS 用 start.command）。
3) 首次运行 Windows 防火墙提示时选择「允许访问」。
4) 好友会自动出现在左侧列表；若没有，点「+ 添加好友」输入对方 IP（如 192.168.1.7）。
5) 也可以改 data/config.json 的 manual_peers，通过代码/配置添加好友。
6) 双击好友头像可编辑备注名、头像颜色、分组、备注、置顶、消息免打扰。
7) 发文件：点回形针选文件，或点文件夹图标选整个文件夹，也可直接把文件/文件夹拖进窗口。
   —— 拖文件夹是按「一个文件夹」整体发送：一条消息、一个总进度，对方还原完整目录结构。
8) 截屏：点输入框上方的截屏图标，在图上拖出区域后直接发送（桌面版）。
9) 收到的文件在「设置 → 接收文件保存到」指定的目录（默认 exe 同级 data/downloads）。
   每个收到的文件/文件夹都有「另存为 / 打开文件夹」，可直接存到你想要的位置。
10) 撤回：自己发的消息 2 分钟内可撤回，对方那边会同步消失。
11) 关闭窗口 = 最小化到托盘，托盘菜单可打开窗口 / 打开接收目录 / 免打扰 / 退出。
12) 消息弹窗：主窗口不在前台时，新消息在屏幕右下角弹出卡片，点一下直接回到该会话。
13) Win 与 macOS 互通：两边跑同一份代码即可，协议与操作系统无关。
"""


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32":
            # SO_REUSEADDR 在 Windows 上允许重复占用地址；端口只能由一个实例持有。
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        # WebView / 浏览器随手断开的连接不值得刷一屏 traceback（日志里看着像崩了）
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError, OSError)):
            return
        super().handle_error(request, client_address)


def build_arg_parser():
    ap = argparse.ArgumentParser(description=APP_NAME + " · 局域网文件互传 + 好友聊天")
    ap.add_argument("--http-port", type=int, default=None)
    ap.add_argument("--udp-port", type=int, default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--add", default="", help="启动时添加一个好友地址 ip[:port]")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--tray", action="store_true", help="启动后不弹窗口，静默到托盘")
    return ap


class ListenError(RuntimeError):
    pass


def boot(args):
    """先独占端口，再加载数据和启动线程。返回 (httpd, port)。"""
    directory = Path(args.data_dir).resolve() if args.data_dir else DATA_DIR
    saved = load_json(directory / "config.json", {})
    port = int(args.http_port or saved.get("http_port", DEFAULT_HTTP_PORT))
    try:
        httpd = Server(("0.0.0.0", port), Handler)
    except OSError as e:
        if e.errno == errno.EADDRINUSE or getattr(e, "winerror", None) in (10013, 10048):
            raise ListenError(
                "端口 {} 已被占用。请从任务栏右下角的系统托盘退出其他版本的近传，再重新启动。".format(port)
            ) from e
        raise ListenError("启动本地服务失败（端口 {}）：{}".format(port, e)) from e
    try:
        init_store(args)
    except BaseException:
        httpd.server_close()
        raise

    print("=" * 58)
    print("  {} v{}  |  {}".format(APP_NAME, VERSION, platform.system()))
    print("=" * 58)
    print("  本机名称 : {}".format(ME["name"]))
    print("  局域网IP : {}".format(ME["ip"]))
    print("  访问地址 : http://127.0.0.1:{}/".format(port))
    print("  其它电脑 : http://{}:{}/".format(ME["ip"], port))
    print("  接收目录 : {}".format(DOWNLOAD_DIR))
    print("  配置目录 : {}".format(DATA_DIR))
    print("=" * 58)

    threading.Thread(target=refresher_loop, daemon=True).start()
    threading.Thread(target=udp_listener_loop, daemon=True).start()
    threading.Thread(target=udp_sender_loop, daemon=True).start()
    threading.Thread(target=legacy_keepalive_loop, daemon=True).start()

    for addr in list(CONFIG.get("manual_peers", [])) + ([args.add] if args.add else []):
        if addr:
            threading.Thread(target=register_addr, args=(addr,), daemon=True).start()

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def main():
    args = build_arg_parser().parse_args()
    try:
        httpd, port = boot(args)
    except ListenError as e:
        raise SystemExit(str(e)) from e
    url = "http://127.0.0.1:{}/".format(port)
    if not args.no_browser and not args.tray:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print("  服务已启动，按 Ctrl+C 退出\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n正在退出...")
        httpd.shutdown()


if __name__ == "__main__":
    main()
