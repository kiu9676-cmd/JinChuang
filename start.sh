#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "未找到 Python 3.8+，请先安装"
  exit 1
fi
exec "$PY" server.py "$@"
