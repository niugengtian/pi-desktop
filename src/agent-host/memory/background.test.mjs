import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers";
import { importTestBundle } from "#test-bundle";
import { memoryRecordId } from "./markdown-store.mjs";

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-memory-background-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  delete globalThis.__taskMemoryRunner;
  rmSync(agentDir, { recursive: true, force: true });
});
const root = path.resolve(import.meta.dirname, "..", "..", "..");
let bundled;
async function extension() {
  bundled ??= importTestBundle("memory-background", {
    entryPoints: [path.join(import.meta.dirname, "extension.ts")],
    packages: "external",
    absWorkingDir: root,
    plugins: [
      {
        name: "controlled-local-runner",
        setup(build) {
          build.onResolve({ filter: /^\.\/local-model\.mjs$/ }, () => ({ path: "local-runner", namespace: "fixture" }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export async function createLocalMemoryRunner(options) { return globalThis.__taskMemoryRunner(options); }",
            loader: "js",
          }));
        },
      },
    ],
  });
  return (await bundled).createTaskMemoryExtension;
}
async function drain() {
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
}
let sequence = 0;
async function fixture(t) {
  const events = new Map();
  const commands = new Map();
  let resolve;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const state = {
    sessionId: `background-${++sequence}`,
    leaf: "answer",
    calls: [],
    ledgers: [],
    notifications: [],
    statuses: [],
  };
  const entries = [
    {
      type: "message",
      id: "goal",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Fictional task", timestamp: 1 },
    },
    {
      type: "message",
      id: "answer",
      parentId: "goal",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Task noted" }],
        stopReason: "stop",
        provider: "fixture",
        model: "fast",
      },
    },
  ];
  const manager = { getSessionId: () => state.sessionId, getLeafId: () => state.leaf, getBranch: () => [...entries] };
  const ctx = {
    sessionManager: manager,
    isIdle: () => true,
    ui: {
      setStatus: (_key, text) => state.statuses.push(text),
      notify: (text) => state.notifications.push(text),
      confirm: async () => false,
    },
  };
  globalThis.__taskMemoryRunner =
    ({ signal }) =>
    async () => {
      state.calls.push({ signal });
      return state.nextGate ?? gate; // Deliberately ignores abort to exercise late-result protection.
    };
  const pi = {
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, options) => commands.set(name, options.handler),
    appendEntry: (customType, data) => {
      state.ledgers.push(data);
      const id = `ledger-${state.ledgers.length}`;
      entries.push({ type: "custom", id, parentId: state.leaf, timestamp: "2026-01-01T00:00:02Z", customType, data });
      state.leaf = id;
    },
  };
  (await extension())().factory(pi);
  await events.get("session_start")({}, ctx);
  t.after(async () => {
    events.get("session_shutdown")?.({}, ctx);
    resolve("目标：虚构任务已记录");
    await drain();
  });
  const file = path.join(
    agentDir,
    "task-memory-vault",
    "hot",
    `${memoryRecordId(state.sessionId, ["goal", "answer"])}.md`,
  );
  return { events, commands, ctx, state, file, resolve, entries, message: entries[1].message };
}
async function start(f) {
  const result = f.events.get("turn_end")({ message: f.message }, f.ctx);
  assert.equal(result, undefined, "turn_end must not wait for the memory model");
  assert.equal(f.state.calls.length, 0, "memory must wait until the native run settles");
  f.events.get("agent_settled")({}, f.ctx);
  await drain();
  assert.equal(f.state.calls.length, 1);
}

test("completed turn returns before a slow memory update; idle completion writes one ledger", async (t) => {
  const f = await fixture(t);
  const returned = f.events.get("turn_end")({ message: f.message }, f.ctx);
  try {
    assert.equal(returned, undefined, "turn_end must not await a slow summary");
    assert.equal(f.state.calls.length, 0);
    f.events.get("agent_settled")({}, f.ctx);
    await drain();
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.ledgers.length, 0);
  } finally {
    f.resolve("目标：虚构任务已记录");
    await returned;
    await drain();
  }
  assert.equal(f.state.ledgers.length, 1);
  assert.ok(existsSync(f.file));
});

test("a new prompt cancels old memory and late results cannot write", async (t) => {
  const f = await fixture(t);
  await start(f);
  f.events.get("before_agent_start")({}, f.ctx);
  assert.equal(f.state.calls[0].signal.aborted, true);
  f.resolve("Old summary");
  await drain();
  assert.equal(f.state.ledgers.length, 0);
  assert.equal(existsSync(f.file), false);
});

test("session replacement and branch drift prevent old writes", async (t) => {
  const f = await fixture(t);
  await start(f);
  f.events.get("session_before_switch")({}, f.ctx);
  f.state.sessionId = "new-session";
  f.resolve("Old session summary");
  await drain();
  assert.equal(f.state.ledgers.length, 0);
  assert.equal(existsSync(f.file), false);
  const branch = await fixture(t);
  await start(branch);
  branch.state.leaf = "different-branch"; // Even without a lifecycle cancellation event.
  branch.resolve("Old branch summary");
  await drain();
  assert.equal(branch.state.ledgers.length, 0);
  assert.equal(existsSync(branch.file), false);
});

test("source changes without leaf movement invalidate the fingerprint", async (t) => {
  const f = await fixture(t);
  await start(f);
  f.message.content[0].text = "A changed source after inference started";
  f.resolve("Summary of the old source");
  await drain();
  assert.equal(f.state.ledgers.length, 0);
  assert.equal(existsSync(f.file), false);
});

test("rapid successive turns keep only the latest job and preserve its busy status", async (t) => {
  const f = await fixture(t);
  await start(f);
  f.events.get("before_agent_start")({}, f.ctx);
  let finishNext;
  f.state.nextGate = new Promise((resolve) => {
    finishNext = resolve;
  });
  f.entries.push(
    {
      ...f.entries[0],
      id: "goal2",
      parentId: "answer",
      message: { role: "user", content: "Second fictional request", timestamp: 2 },
    },
    {
      ...f.entries[1],
      id: "answer2",
      parentId: "goal2",
      message: { ...f.message, content: [{ type: "text", text: "Second request recorded" }] },
    },
  );
  f.state.leaf = "answer2";
  f.events.get("turn_end")({ message: f.entries.at(-1).message }, f.ctx);
  f.events.get("agent_settled")({}, f.ctx);
  await drain();
  assert.equal(f.state.calls.length, 2);
  f.resolve("Old result");
  await drain();
  assert.equal(f.state.ledgers.length, 0);
  assert.match(f.state.statuses.at(-1), /background/);
  finishNext("Latest task memory");
  await drain();
  assert.equal(f.state.ledgers.length, 1);
  assert.equal(f.state.ledgers[0].summary, "Latest task memory");
  assert.equal(existsSync(f.file), false);
});

test("manual edits made while summary is pending survive and no ledger is appended", async (t) => {
  const f = await fixture(t);
  await start(f);
  mkdirSync(path.dirname(f.file), { recursive: true });
  writeFileSync(f.file, "Human authored memory; do not replace.\n");
  f.resolve("Generated replacement");
  await drain();
  assert.equal(readFileSync(f.file, "utf8"), "Human authored memory; do not replace.\n");
  assert.equal(f.state.ledgers.length, 0);
  assert.ok(f.state.notifications.some((text) => text.includes("manual edits were preserved")));
});

test("explicit cancel and shutdown abort pending work without leaving busy status", async (t) => {
  const f = await fixture(t);
  await start(f);
  await f.commands.get("task-memory-cancel")("", f.ctx);
  assert.equal(f.state.calls[0].signal.aborted, true);
  f.resolve("Cancelled result");
  await drain();
  assert.equal(f.state.ledgers.length, 0);
  assert.equal(f.state.statuses.at(-1), undefined);
  const shutdown = await fixture(t);
  await start(shutdown);
  shutdown.events.get("session_shutdown")({}, shutdown.ctx);
  shutdown.resolve("Shutdown result");
  await drain();
  assert.equal(shutdown.state.ledgers.length, 0);
  assert.equal(existsSync(shutdown.file), false);
});

test("background failure and a broken notification UI cannot leave the task busy", async (t) => {
  const f = await fixture(t);
  await start(f);
  f.ctx.ui.notify = () => {
    throw Error("Notification UI unavailable");
  };
  f.resolve(Promise.reject(Error("Local model offline")));
  await drain();
  assert.equal(f.state.ledgers.length, 0);
  assert.equal(existsSync(f.file), false);
  assert.equal(f.state.statuses.at(-1), "Memory update failed");
});

test("disabled settings during inference prevent publication", async (t) => {
  const f = await fixture(t);
  await start(f);
  const settings = path.join(agentDir, "task-memory.json");
  writeFileSync(
    settings,
    JSON.stringify({ enabled: false, primary: "ollama-local/pi-qwen3-4b-summary:q4km", fallback: null }),
  );
  try {
    f.resolve("Disabled result");
    await drain();
    assert.equal(f.state.ledgers.length, 0);
    assert.equal(existsSync(f.file), false);
  } finally {
    rmSync(settings);
  }
});
