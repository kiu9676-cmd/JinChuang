@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 近传

echo ============================================================
echo   近传 局域网互传（桌面版：托盘 / 悬浮窗 / 消息弹窗）
echo   首次运行请在弹出的防火墙提示里选「允许访问」
echo   关闭窗口 = 最小化到托盘，托盘菜单里可退出
echo ============================================================
echo.

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE (
  where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
  echo [错误] 没有找到 Python 3.8+
  echo 请到 https://www.python.org/downloads/ 安装，安装时勾选 "Add Python to PATH"
  pause & exit /b 1
)

rem 装了 pywebview 就是桌面窗口，没有则自动退回浏览器模式
%PYEXE% desktop.py %*

echo.
echo 近传 已退出。
pause
