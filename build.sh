#!/usr/bin/env bash
# 在 macOS 上运行可生成 dist/近传（也可自行加 --windowed 生成 .app）
cd "$(dirname "$0")" || exit 1
if [ -d web/games/mj ]; then
  echo "请从公开仓库的干净工作树重新构建，勿打包旧素材目录。" >&2
  exit 1
fi
PY=python3
echo Building single-file macOS binary ...
$PY -m pip install --upgrade pyinstaller || exit 1
$PY -m PyInstaller --onefile --clean --name 近传 --add-data "web:web" server.py
echo "Done: dist/近传"
