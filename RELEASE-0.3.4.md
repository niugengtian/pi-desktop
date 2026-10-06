# Pi Agent Desktop 0.3.4

修复 macOS 共享终端连接失败：打包后恢复 node-pty 的 spawn-helper 执行权限，并在发布验证中检查权限和真实 PTY 启动。终端回归验证覆盖 tmux 连接、输入输出、断开和重新连接。
