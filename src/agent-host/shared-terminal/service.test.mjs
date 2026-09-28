import assert from "node:assert/strict";
import test from "node:test";
import { SharedTerminalService } from "./service.ts";

test("共享终端探测返回稳定且不泄露环境的结果", async () => {
  const service = new SharedTerminalService();
  const result = await service.probe(true);
  assert.equal(typeof result.supported, "boolean");
  if (result.supported) {
    assert.match(result.tmuxPath, /^\//);
    assert.match(result.version, /^tmux /i);
  } else {
    assert.ok(["platform-unsupported", "tmux-not-found", "probe-failed"].includes(result.reason));
  }
});

test("无效工作目录在创建共享终端前被拒绝", async () => {
  const service = new SharedTerminalService();
  service.probe = async () => ({ supported: true, tmuxPath: "/usr/bin/false", version: "tmux test" });
  await assert.rejects(() => service.ensure("session", "relative/path"), /绝对路径/);
});
