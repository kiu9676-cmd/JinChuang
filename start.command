#!/usr/bin/env bash
# macOS: 双击运行（首次使用需 chmod +x start.command）
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "未找到 Python 3.8+，请先安装：https://www.python.org/downloads/"
  read -r -p "按回车键退出..." _
  exit 1
fi
echo "正在启动 近传 ...（若系统提示防火墙/网络访问，请选择允许）"
exec "$PY" server.py "$@"
