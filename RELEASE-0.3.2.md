# Pi Agent Desktop 0.3.2

新电脑只需安装 Pi Agent Desktop 和 OpenCLIApp，无需另装 Page Provider 插件或 Web 修复包。

- ChatGPT Web、DeepSeek Chat Web、DeepSeek Reasoner Web 随应用默认加载，在空白用户配置下直接出现在模型列表。
- ChatGPT / DeepSeek 图片与会话连续性修复适配器随应用内置，由应用直接调用；不依赖 `~/.opencli/clis` 中的覆盖文件，也不改写 OpenCLIApp 安装。
- 已手动安装旧 Page Provider 的用户无需卸载，应用避免重复注册其模型、命令和会话事件。
- 延续 0.3.1 的三层记忆、图片分批传递、API / Web 会话复用和团队入口移除。

## 安装

1. 下载 macOS Apple Silicon（M 系列芯片）DMG，退出旧应用，将 Pi Agent Desktop 拖入 Applications。
2. 使用 Web 模型时安装并运行 OpenCLIApp，完成它自己的浏览器连接，在相应网站登录后，在 Pi Agent Desktop 模型列表选择 Web 模型。
3. 使用 API 模型时在 Pi Agent Desktop 中配置相应认证。首次安装不会附带旧电脑的 API 凭证、浏览器登录或对话历史。

应用采用本地 ad-hoc 签名，尚未经过 Apple Developer ID 签名或公证。此次只发布 macOS arm64 构建。

跨对话创建/绑定目录和完整四级约定解析器仍未完整实现。本发布不宣称这些功能已完成。
