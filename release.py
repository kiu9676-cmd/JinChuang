#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键发版：改版本号 → 打包 exe → 上传到 GitHub Release。

发版（客户端「检查更新」读到的就是这里发布的内容）：

    set GITHUB_TOKEN=ghp_xxx            # 需要 repo 权限的 token（Windows）
    python release.py --repo yourname/jinchuan              # 修订号 +1（1.1.0 → 1.1.1）
    python release.py --repo yourname/jinchuan --minor      # 次版本 +1（1.1.0 → 1.2.0）
    python release.py --repo yourname/jinchuan --version 2.0.0

其它用法：

    python release.py --build-only                  # 只打包，不上传
    python release.py --no-build --repo o/r         # 用现成的 dist/近传.exe 发版
    python release.py --repo o/r --notes "修了搜索崩溃"

没有 GITHUB_TOKEN 也能用：脚本会打包并把要上传的文件、Release 说明准备好，
再打印手动上传步骤（网页上传同样有效）。
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"
CHANGELOG = ROOT / "CHANGELOG.md"
DIST = ROOT / "dist"
APP_NAME = "近传"
API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"
SKIP_DIRS = {"data", "dist", "build_tmp", "screenshots", "__pycache__", ".git",
             ".idea", ".vscode", ".venv", "venv", ".workbuddy", "node_modules"}


def log(*a):
    print(*a, flush=True)


def read_version():
    m = re.search(r'^VERSION\s*=\s*"([^"]+)"', SERVER.read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else "0.0.0"


def bump(version, part="patch"):
    nums = [int(x) for x in re.findall(r"\d+", version)[:3]]
    while len(nums) < 3:
        nums.append(0)
    if part == "major":
        nums = [nums[0] + 1, 0, 0]
    elif part == "minor":
        nums = [nums[0], nums[1] + 1, 0]
    else:
        nums = [nums[0], nums[1], nums[2] + 1]
    return ".".join(str(n) for n in nums)


def write_version(version):
    text = SERVER.read_text(encoding="utf-8")
    today = datetime.date.today().isoformat()
    text = re.sub(r'^VERSION\s*=\s*"[^"]+"', 'VERSION = "{}"'.format(version), text, count=1, flags=re.M)
    text = re.sub(r'^BUILD_DATE\s*=\s*"[^"]+"', 'BUILD_DATE = "{}"'.format(today), text, count=1, flags=re.M)
    SERVER.write_text(text, encoding="utf-8")


def changelog_section(version):
    """取 CHANGELOG 里该版本的小节（用作 Release 说明）。"""
    if not CHANGELOG.is_file():
        return ""
    text = CHANGELOG.read_text(encoding="utf-8")
    m = re.search(r"^## v{}[^\n]*\n(.*?)(?=^## |\Z)".format(re.escape(version)),
                  text, re.M | re.S)
    return (m.group(1).strip() if m else "")


def ensure_changelog(version, notes):
    text = CHANGELOG.read_text(encoding="utf-8") if CHANGELOG.is_file() else "# 更新日志\n"
    if "## v{}".format(version) in text:
        return
    today = datetime.date.today().isoformat()
    section = "## v{} · {}\n\n{}\n\n".format(version, today, notes.strip() or "- 修复若干问题")
    idx = text.find("\n## v")
    text = (text[:idx + 1] + section + text[idx + 1:]) if idx > 0 else (text.rstrip() + "\n\n" + section)
    CHANGELOG.write_text(text, encoding="utf-8")


def find_pyinstaller(python):
    for cand in [python, sys.executable]:
        try:
            out = subprocess.run([cand, "-m", "PyInstaller", "--version"],
                                 capture_output=True, text=True, timeout=60)
            if out.returncode == 0:
                return cand, out.stdout.strip()
        except Exception:
            continue
    # 常见安装位置兜底
    for cand in [r"C:\Users\%s\AppData\Local\Programs\Python\Python312\python.exe" % os.environ.get("USERNAME", ""),
                 r"C:\Python312\python.exe"]:
        try:
            out = subprocess.run([cand, "-m", "PyInstaller", "--version"],
                                 capture_output=True, text=True, timeout=60)
            if out.returncode == 0:
                return cand, out.stdout.strip()
        except Exception:
            continue
    return None, ""


def build(python, version):
    py, ver = find_pyinstaller(python)
    if not py:
        log("[!] 没找到 PyInstaller。先执行：pip install pyinstaller")
        return None
    log("[1/3] 打包 exe（PyInstaller {}）…".format(ver))
    if (ROOT / "web" / "games" / "mj").exists():
        raise SystemExit("检测到未纳入公开发行的旧素材目录，请从公开仓库的干净工作树重新构建。")
    DIST.mkdir(exist_ok=True)
    cmd = [py, "-m", "PyInstaller", "--onefile", "--noconsole", "--clean",
           "--name", APP_NAME,
           "--icon", str(ROOT / "assets" / "icon.ico"),
           "--add-data", "{};web".format(ROOT / "web"),
           "--add-data", "{};assets".format(ROOT / "assets"),
           "--hidden-import", "server", "--hidden-import", "desktop",
           "--collect-all", "webview", "--collect-all", "pystray",
           "--collect-all", "PIL", "--collect-all", "pythonnet",
           "--collect-all", "clr_loader",
           "--distpath", str(DIST),
           "--workpath", str(ROOT / "build_tmp"),
           "--specpath", str(ROOT / "build_tmp"),
           str(ROOT / "desktop.py")]
    r = subprocess.run(cmd, cwd=str(ROOT))
    exe = DIST / (APP_NAME + ".exe")
    if r.returncode != 0 or not exe.is_file():
        log("[!] 打包失败")
        return None
    log("      -> {}  ({:.1f} MB)".format(exe, exe.stat().st_size / 1048576))
    return exe


def make_source_zip(version):
    target = DIST / "{}-{}-source.zip".format(APP_NAME, version)
    log("[2/3] 打包源码 zip …")
    try:
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit("源码包需要 Git 工作树；可用 --no-zip 只构建可执行文件。") from exc
    files = [Path(name.decode("utf-8")) for name in tracked.split(bytes(1)) if name]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            p = ROOT / rel
            if (not p.is_file() or p.is_symlink() or ROOT not in p.resolve().parents
                    or p.name == ".env" or p.name.startswith(".env.")
                    or any(part in SKIP_DIRS for part in rel.parts)
                    or rel.parts[:3] == ("web", "games", "mj")
                    or p.suffix.lower() in (".exe", ".spec", ".zip", ".log", ".pyc")):
                continue
            z.write(p, rel.as_posix())
    log("      -> {}  ({:.0f} KB)".format(target, target.stat().st_size / 1024))
    return target


def api(method, url, data=None, token=None, raw=None, ctype=None):
    body, headers = None, {"User-Agent": "JinChuan-release",
                           "Accept": "application/vnd.github+json"}
    if raw is not None:
        body = raw
        headers["Content-Type"] = ctype or "application/octet-stream"
    elif data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            txt = r.read().decode("utf-8") or "{}"
            return r.status, json.loads(txt)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def upload(repo, version, body, files, token, prerelease=False):
    tag = "v" + version
    log("[3/3] 创建 Release {} …".format(tag))
    status, rel = api("POST", "{}/repos/{}/releases".format(API, repo), {
        "tag_name": tag, "name": "{} {}".format(APP_NAME, tag), "body": body,
        "draft": False, "prerelease": bool(prerelease)}, token)
    if status == 422:                      # 已存在：拿现成的
        status, rel = api("GET", "{}/repos/{}/releases/tags/{}".format(API, repo, tag), token=token)
    if status not in (200, 201):
        log("[!] 创建 Release 失败：HTTP {} {}".format(status, rel.get("message") or rel))
        return False
    upload_url = str(rel.get("upload_url", "")).split("{")[0]
    for f in files:
        f = Path(f)
        name = f.name
        for a in rel.get("assets") or []:
            if a.get("name") == name:
                api("DELETE", "{}/repos/{}/releases/assets/{}".format(API, repo, a["id"]), token=token)
        log("      上传 {} ({:.1f} MB) …".format(name, f.stat().st_size / 1048576))
        status, res = api("POST", "{}?name={}".format(upload_url, urllib.parse.quote(name)),
                          raw=f.read_bytes(), token=token,
                          ctype="application/octet-stream")
        if status not in (200, 201):
            log("[!] 上传失败：HTTP {} {}".format(status, res.get("message") or res))
            return False
    log("      完成：{}".format(rel.get("html_url", "")))
    return True


def git_release(version, enable=True):
    git = shutil.which("git")
    if not git or not (ROOT / ".git").exists() or not enable:
        return False
    try:
        subprocess.run([git, "add", "-A"], cwd=str(ROOT), check=True)
        subprocess.run([git, "commit", "-m", "release v{}".format(version)],
                       cwd=str(ROOT), check=False)
        subprocess.run([git, "tag", "-a", "v{}".format(version), "-m", "v{}".format(version)],
                       cwd=str(ROOT), check=False)
        subprocess.run([git, "push"], cwd=str(ROOT), check=False)
        subprocess.run([git, "push", "--tags"], cwd=str(ROOT), check=False)
        log("[git] 已提交并推送 tag v{}".format(version))
        return True
    except Exception as e:
        log("[git] 推送失败（不影响上传）：{}".format(e))
        return False


def main():
    ap = argparse.ArgumentParser(description="近传 · 一键发版")
    ap.add_argument("--repo", default=os.environ.get("JINCHUAN_REPO", ""),
                    help="GitHub 仓库 owner/repo")
    ap.add_argument("--version", default="", help="指定版本号，如 1.2.0")
    ap.add_argument("--major", action="store_true")
    ap.add_argument("--minor", action="store_true")
    ap.add_argument("--notes", default="", help="版本说明（默认取 CHANGELOG 对应小节）")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--no-zip", action="store_true")
    ap.add_argument("--prerelease", action="store_true")
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--no-git", action="store_true")
    args = ap.parse_args()

    current = read_version()
    part = "major" if args.major else ("minor" if args.minor else "patch")
    version = args.version or bump(current, part)
    log("=" * 62)
    log(" {} 发版：{} → v{}".format(APP_NAME, current, version))
    log("=" * 62)

    if not args.no_build:
        write_version(version)
        ensure_changelog(version, args.notes)
        exe = build(args.python, version)
        if not exe:
            sys.exit(1)
    else:
        exe = DIST / (APP_NAME + ".exe")
        if not exe.is_file():
            log("[!] 没有现成的 {}，去掉 --no-build 重新打包".format(exe))
            sys.exit(1)

    body = args.notes.strip() or changelog_section(version) or "v{}".format(version)
    files = [exe]
    if not args.no_zip:
        files.append(make_source_zip(version))

    sha = hashlib.sha256(exe.read_bytes()).hexdigest()
    log("      SHA256 {}".format(sha))

    git_release(version, enable=not args.no_git)

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    repo = (args.repo or "").strip().strip("/")
    if args.build_only or not repo or not token:
        log("\n[手动上传] 打开 https://github.com/{}/releases/new 新建 Release：".format(repo or "owner/repo"))
        log("   tag: v{}   （客户端按 tag 比较版本）".format(version))
        log("   把下面这些文件拖进附件：")
        for f in files:
            log("     - {}".format(f))
        log("   说明正文已写好：release_notes.txt")
        (DIST / "release_notes.txt").write_text(body, encoding="utf-8")
        if not token:
            log("\n  想自动上传就设 GITHUB_TOKEN（repo 权限）后重跑。")
        return

    ok = upload(repo, version, body, files, token, args.prerelease)
    if ok:
        log("\n打包机/客户端现在就能更新了：设置 → 更新 → 检查更新。")


if __name__ == "__main__":
    main()
