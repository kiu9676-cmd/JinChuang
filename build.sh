#!/usr/bin/env bash
# Build a native macOS app for the architecture of the selected Python.
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin || -d web/games/mj ]]; then
  echo "请在 macOS 上从公开仓库的干净工作树构建。" >&2
  exit 1
fi
PYTHON="${PYTHON:-python3}"
ARCH="$("$PYTHON" -c 'import platform; print(platform.machine())')"
VERSION="$("$PYTHON" -c 'from release import read_version; print(read_version())')"

"$PYTHON" -c 'from pathlib import Path; from PIL import Image; Path("build_tmp").mkdir(exist_ok=True); Image.open("assets/icon.png").save("build_tmp/icon.icns")'
"$PYTHON" -m PyInstaller --clean --noconfirm --windowed --onedir --name JinChuan \
  --target-architecture "$ARCH" --osx-bundle-identifier com.jinchuan.app \
  --icon build_tmp/icon.icns --add-data 'web:web' --add-data 'LICENSE:.' \
  --workpath build_tmp --specpath . --distpath dist macos_app.py
APP=dist/JinChuan.app
INFO="$APP/Contents/Info.plist"
"$PYTHON" - "$INFO" "$VERSION" <<'PY'
import plistlib
from pathlib import Path
import sys

path = Path(sys.argv[1])
info = plistlib.loads(path.read_bytes())
info.update(
    CFBundleDisplayName="近传",
    CFBundleShortVersionString=sys.argv[2],
    CFBundleVersion=sys.argv[2],
    LSMinimumSystemVersion="15.0",
    NSLocalNetworkUsageDescription="近传使用局域网查找设备并直接传输消息和文件。",
    NSAppTransportSecurity={"NSAllowsLocalNetworking": True},
)
path.write_bytes(plistlib.dumps(info))
PY

NOTICES="$APP/Contents/Resources/Third-Party-Licenses"
mkdir -p "$NOTICES"
cp THIRD_PARTY_NOTICES.md "$NOTICES/JinChuang.txt"
cp web/games/majiang/LICENSE "$NOTICES/Sichuan-Mahjong.txt"
"$PYTHON" packaging_macos_notices.py "$NOTICES"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
[[ "$(lipo -archs "$APP/Contents/MacOS/JinChuan")" == "$ARCH" ]]
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/JinChuan-v${VERSION}-macOS-${ARCH}.zip"
