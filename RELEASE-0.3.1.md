# Pi Agent Desktop 0.3.1

本次修复长对话记忆、图片传递和模型切换后的会话连续性，并移除任务团队入口。

- cool 保留原始 JSONL，warm 使用 Flash 按需分段增量总结，hot 使用 Pi 原生压缩后的实际活跃上下文。
- 修复旧记忆扩展因来源大小限制阻止普通对话的问题。
- 原图单张限制 10 MiB，每批最多 8 张；更多图片通过连续轮次传递，最后处理当前请求。
- API 切换 A→B→A 时复用原 A 会话。Web 绑定同样复用真实会话 ID，未确认回复不会推进图片同步游标。
- 修复 DeepSeek Web 隐藏附件加载图标造成的等待失败，以及 ChatGPT Web 丢弃不同轮次相同回复的问题。
- 打包使用静止输入，并核验 ASAR 每个文件和模型运行时依赖。

## 下载和安装

此构建提供 macOS Apple Silicon（arm64）版本，使用本地 ad-hoc 签名，未经过 Apple Developer ID 签名或公证。

1. 下载应用 DMG 或 ZIP，退出 Pi Agent Desktop，将应用复制到 Applications。
2. 使用 ChatGPT / DeepSeek Web 的用户还需下载 `Pi-OpenCLI-Web-Repairs-0.3.1.zip`，解压并在 Terminal 中运行其中的 `install.command`。脚本校验文件、备份旧覆盖文件，再安装修复适配器。
3. 保持 OpenCLIApp 运行，并在其连接的浏览器中登录目标网站，然后重新打开 Pi Agent Desktop。

已有的模型认证和普通对话历史保存在用户数据目录，应用包不包含这些内容。

## 已有真实模型验收

13 个远程模型文本测试通过，12 个图片测试通过。DeepSeek V4 Pro 官方 API 不支持视觉，不计为已通过图片验收。Spark 和本地模型不在测试范围。

两个 DeepSeek Web 模式的图片、ChatGPT Web 图片、ChatGPT→DeepSeek→原 ChatGPT 会话、API 原会话复用及 9 张图片按 8＋1 分批传递均通过。原故障长对话的副本恢复通过，原 JSONL 未修改。

跨对话创建/绑定目录和完整四级约定解析器仍未完整实现，本发布不宣称这两项已经完成。
