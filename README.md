<p align="center"><img src="web/logo.png" width="80" alt="近传 Logo"></p>

<h1 align="center">近传 · JinChuang</h1>

<p align="center">在同一个局域网里，直接聊天、发图、传文件。</p>

<p align="center">
  <a href="https://github.com/kiu9676-cmd/JinChuang/archive/refs/heads/main.zip">下载源码</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/USAGE.md">使用手册</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="LICENSE">MIT</a>
</p>

近传适合在可信的家庭或工作室网络里，把截图和文件从一台电脑发到另一台。不需要注册账号，消息和文件由设备直接交换，不经云端转发。Windows 可使用桌面窗口和托盘，也可以用浏览器连接本机运行的服务。

![近传会话界面：设备列表、文字和文件消息](docs/images/conversation.png)

## 能做什么

- **找到同一网络里的设备**：自动发现，或手动添加 IP。连不上时，可以在添加好友或好友资料里检测地址和端口。
- **聊天和查附件**：支持单聊和群聊、截图、拖放文件和文件夹。按 `Ctrl+F`（macOS：`⌘F`）搜索当前会话，再按类型筛选和定位。
- **大文件传到一半也能接着传**：双方使用 v1.6.1 或更新版本时，单聊的文件和图片支持暂停、继续、取消；按接收端确认的进度恢复，完成后校验 SHA-256。
- **数据留在本机**：聊天记录、好友资料和接收文件默认保存在 `data/`，接收目录可自定义。

[查看暂停传输界面](docs/images/transfer.png)。文件夹和群文件沿用原有传输方式，暂未加入断点续传。

## 快速开始

推荐使用 **Python 3.12**。在两台设备上各运行一份：

```bash
git clone https://github.com/kiu9676-cmd/JinChuang.git
cd JinChuang
python server.py
```

macOS / Linux 可用 `python3` 运行。浏览器默认打开 `http://127.0.0.1:8765`；如果没有自动打开，访问终端显示的本机地址。让两台设备连接同一网络，看到对方出现在会话列表后即可发送。看不到时，点「+」，输入对方在近传里显示的 IP（可带端口）。

### Windows 桌面模式

```powershell
py -3.12 -m pip install -r requirements-desktop.txt
py -3.12 desktop.py
```

桌面窗口使用 WebView2。首次启动遇到 Windows 防火墙提示时，只为可信的「专用网络」放行。想自行打包便携 EXE，可按[构建说明](CONTRIBUTING.md#构建-windows-exe)操作；更换目录前请保留原来的 `data/`。

## 网络与隐私

近传使用局域网 HTTP、WebSocket 和 UDP 发现，**不提供端到端加密**。不要在不可信的公共网络中传输敏感资料，也不要把服务端口转发到公网。SHA-256 检查文件是否完整，不等于加密或身份验证。客户端的更新检查会访问 GitHub。

## 开发

后端用 Python 标准库，前端是 HTML、CSS 和 JavaScript，无需先构建前端。桌面壳、传输和网页分别位于 `desktop.py`、`transfer_resume.py` 和 `web/`。

- [开发、测试与打包](CONTRIBUTING.md)
- [使用手册与故障排查](docs/USAGE.md)
- [安全问题报告](SECURITY.md)
- [素材及第三方许可说明](THIRD_PARTY_NOTICES.md)

## 许可

项目原创代码和文字文档采用 [MIT License](LICENSE)。内置的四川麻将保留其[独立许可声明](web/games/majiang/LICENSE)；其他素材、标识和外部依赖详见[许可说明](THIRD_PARTY_NOTICES.md)。
