import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importTestBundle } from "#test-bundle";

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-task-memory-extension-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

const root = path.resolve(import.meta.dirname, "..", "..", "..");
test("task memory can be previewed but never changes ordinary provider context", async () => {
  const { createTaskMemoryExtension } = await importTestBundle("task-memory-extension", {
    entryPoints: [path.join(import.meta.dirname, "extension.ts")],
    packages: "external",
    absWorkingDir: root,
  });
  const events = new Map();
  const commands = new Map();
  const pi = {
    on: (name, handler) => {
      events.set(name, handler);
    },
    registerCommand: (name, options) => {
      commands.set(name, options.handler);
    },
    appendEntry: () => {},
  };
  createTaskMemoryExtension().factory(pi);
  assert.equal(events.has("context"), false);
  const entry = {
    type: "custom",
    customType: "pi-desktop-task-memory",
    data: {
      summary: "目标：继续上一项任务",
      sourceHash: "hash",
      modelId: "local/main",
      summaryChars: 11,
      sourceChars: 200,
    },
  };
  const messages = [
    { role: "user", content: "Original earlier user request" },
    { role: "assistant", content: "Original API reply", stopReason: "stop" },
    { role: "user", content: "Original current API request" },
  ];
  const captured = [];
  const ctx = {
    model: { provider: "anthropic" },
    sessionManager: { getBranch: () => [entry] },
    ui: {
      confirm: async (title, content) => {
        captured.push({ title, content });
        return false;
      },
    },
  };
  await events.get("session_start")({}, ctx);
  await commands.get("task-memory-preview")("", ctx);
  assert.match(captured[0].content, /继续上一项任务/);
  assert.equal(messages.at(-1).content, "Original current API request");
});
