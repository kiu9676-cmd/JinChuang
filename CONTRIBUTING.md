# 参与开发

欢迎提交 Bug、文档修订和小范围的 PR。更改传输协议或文件格式前，建议先开 Issue 说明范围和兼容性。

## 开发与测试

- 推荐 Python 3.12。浏览器模式无须安装额外的 Python 包。
- 用 Node.js 22 或更新版本运行 JavaScript 测试，无须 `npm install`。
- Windows 桌面模式使用 `requirements-desktop.txt` 和 WebView2 运行时。

```bash
python server.py --no-browser --data-dir ./data/dev
python -m unittest discover -s tests
node --test tests/mahjong-engine.test.cjs tests/clipboard.test.cjs
```

两个本地实例要分别指定不同的 HTTP 端口、UDP 端口和数据目录。请使用模拟设备名和测试文件。涉及传输的 PR，请说明是否覆盖失败重试、两端重启、旧版互通、文件校验或取消清理；涉及界面的 PR 欢迎附演示截图。

| 路径 | 职责 |
| --- | --- |
| `server.py` | HTTP、UDP 发现、WebSocket、会话、传输调度 |
| `transfer_resume.py` | 分块写入、状态持久化、SHA-256 校验 |
| `desktop.py` | 原生窗口、托盘、通知、截屏与保存对话框 |
| `web/` | 聊天、设置、传输、主题和娱乐入口 |
| `web/games/majiang/` | 当前使用的内置四川麻将 |
| `tests/` | Python 和 JavaScript 回归测试 |

## 构建 Windows EXE

请在 Windows 上从本公开仓库的干净工作树构建。不要复制私人数据、旧构建目录或来源不明的试验素材。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.venv\Scripts\python.exe release.py --build-only --no-git --no-zip --version 1.6.2
```

产物为 `dist/近传.exe`，也可用 `build.bat` 打包。若要发布新版本，核对 `server.py` 中的版本号、`CHANGELOG.md` 和附件哈希；在 GitHub Release 用 `vX.Y.Z` 作为标签，附上已验证的 `.exe`。派生项目应按需设置自己的更新源。

## 提交前

- 请勿提交 `data/`、真实聊天截图、日志、缓存、打包产物、访问令牌或个人配置。
- 增加素材或外部代码时，请注明来源和可再分发的许可证。
- 默认以项目的 MIT 许可提交原创代码和文档；列明第三方例外并保留声明。
