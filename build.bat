@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if exist "web\games\mj\" (
  echo 检测到未纳入公开发行的旧素材目录，请从公开仓库的干净工作树重新构建。
  exit /b 1
)

echo ============================================================
echo   近传 打包为单文件 exe（桌面版：托盘 / 悬浮窗 / 弹窗）
echo ============================================================
echo.

set "PYEXE="
where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE (
  where py >nul 2>nul && set "PYEXE=py"
)
if not defined PYEXE (
  echo [错误] 没有找到 Python，请先安装 Python 3.9+ 并勾选 Add to PATH
  pause & exit /b 1
)

echo [1/3] 检查依赖（pywebview / pystray / pillow / pyinstaller）...
%PYEXE% -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple pywebview pystray pillow pyinstaller
if errorlevel 1 (
  echo [错误] 依赖安装失败，请检查网络后重试
  pause & exit /b 1
)

echo.
echo [2/3] 开始打包（首次约 1-3 分钟）...
%PYEXE% -m PyInstaller --onefile --noconsole --clean --name 近传 ^
  --icon "%~dp0assets\icon.ico" ^
  --add-data "%~dp0web;web" ^
  --add-data "%~dp0assets;assets" ^
  --hidden-import server --hidden-import desktop ^
  --collect-all webview --collect-all pystray ^
  --collect-all PIL --collect-all pythonnet --collect-all clr_loader ^
  --distpath dist --workpath build_tmp --specpath build_tmp desktop.py
if errorlevel 1 (
  echo [错误] 打包失败，请把上面的报错发给开发者
  pause & exit /b 1
)

echo.
echo [3/3] 完成：dist\近传.exe
echo   双击即可运行：托盘图标 + 悬浮窗 + 消息弹窗 + 截屏 + 原生另存为
echo   数据目录：exe 同级的 data\（聊天记录 / 收到的文件 / 日志）
echo.
pause
