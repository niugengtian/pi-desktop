import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settled } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTieredWorkspaceExtension } from "./tiered-extension.ts";

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-tiered-command-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const manager = SessionManager.create(cwd, join(root, "native"));
  manager.appendMessage({ role: "user", content: "Fictional: amber, blue, cyan; planned, not done.", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Fictional reply" }],
    stopReason: "stop",
    provider: "fictional",
    model: "a",
    api: "openai-completions",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 2,
  });
  const commands = new Map();
  const hooks = new Map();
  const notices = [];
  let confirm = async () => true;
  const ctx = {
    sessionManager: manager,
    hasUI: true,
    isIdle: () => true,
    ui: { confirm: (...args) => confirm(...args), notify: (text) => notices.push(text) },
  };
  createTieredWorkspaceExtension().factory({
    registerCommand: (name, config) => commands.set(name, config.handler),
    on: (name, handler) => hooks.set(name, handler),
  });
  const workspaceRoot = join(cwd, `pi_agent_desktop_session-${manager.getSessionId()}`);
  return {
    root,
    cwd,
    manager,
    hooks,
    notices,
    ctx,
    workspaceRoot,
    setConfirm: (fn) => {
      confirm = fn;
    },
    command: (name) => commands.get(name)("", ctx),
  };
}

test("default off: no files, no context/compaction/provider hook, no native history change", async (t) => {
  const f = harness(t);
  const original = readFileSync(f.manager.getSessionFile());
  assert.equal(f.hooks.has("context"), false);
  assert.equal(f.hooks.has("context_with_system"), false);
  assert.equal(f.hooks.has("session_before_compact"), false);
  assert.equal(f.hooks.has("before_provider_request"), false);
  f.hooks.get("model_select")({ model: { provider: "fixture", id: "b" }, source: "set" }, f.ctx);
  f.hooks.get("agent_settled")({}, f.ctx);
  await settled();
  assert.equal(existsSync(f.workspaceRoot), false);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), original);
});

test("approval is specific to full LOCAL export; decline causes no workspace", async (t) => {
  const f = harness(t);
  let message;
  f.setConfirm(async (_title, text) => {
    message = text;
    return false;
  });
  await f.command("tiered-workspace-enable");
  assert.match(message, /inactive branches\/tools/);
  assert.match(message, /Not automatically redacted/);
  assert.match(message, /no extra model request/);
  assert.equal(existsSync(f.workspaceRoot), false);
});

test("approved exports follow lifecycle, model switches create only pending local relay evidence", async (t) => {
  const f = harness(t);
  await f.command("tiered-workspace-enable");
  assert.equal(JSON.parse(readFileSync(join(f.workspaceRoot, "workspace.json"))).revision, 1);
  for (const id of ["b", "a"]) {
    f.manager.appendModelChange("fixture", id);
    f.hooks.get("model_select")({ model: { provider: "fixture", id }, source: "set" }, f.ctx);
  }
  const state = JSON.parse(readFileSync(join(f.workspaceRoot, "workspace.json")));
  assert.equal(state.relays.length, 2);
  assert.equal(state.revision, 3);
  for (const relay of state.relays) {
    assert.equal(JSON.parse(readFileSync(join(f.workspaceRoot, relay, "binding.json"))).status, "pending-not-sent");
    assert.equal(readdirSync(join(f.workspaceRoot, relay)).includes("received.jsonl"), false);
  }
  f.hooks.get("session_shutdown")({}, f.ctx);
  f.hooks.get("agent_settled")({}, f.ctx);
  await settled();
  assert.equal(JSON.parse(readFileSync(join(f.workspaceRoot, "workspace.json"))).revision, 3);
});

test("navigation invalidates pending approval and a new turn cancels scheduled export", async (t) => {
  const f = harness(t);
  let approve;
  f.setConfirm(
    () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  );
  const enabling = f.command("tiered-workspace-enable");
  f.hooks.get("session_before_tree")({}, f.ctx);
  approve(true);
  await enabling;
  assert.equal(existsSync(f.workspaceRoot), false);
  f.setConfirm(async () => true);
  await f.command("tiered-workspace-enable");
  f.hooks.get("agent_settled")({}, f.ctx);
  f.hooks.get("before_agent_start")({}, f.ctx);
  await settled();
  assert.equal(JSON.parse(readFileSync(join(f.workspaceRoot, "workspace.json"))).revision, 1);
});

test("manual conflict pauses observer without changing native history or throwing into chat", async (t) => {
  const f = harness(t);
  await f.command("tiered-workspace-enable");
  const native = readFileSync(f.manager.getSessionFile());
  writeFileSync(join(f.workspaceRoot, "warm/summary.md"), "Human protected note");
  f.hooks.get("agent_settled")({}, f.ctx);
  await settled();
  assert.ok(f.notices.some((notice) => notice.includes("Human edit protected")));
  await f.command("tiered-workspace-refresh");
  assert.ok(f.notices.at(-1).startsWith("Disabled"));
  assert.equal(readFileSync(join(f.workspaceRoot, "warm/summary.md"), "utf8"), "Human protected note");
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), native);
});
