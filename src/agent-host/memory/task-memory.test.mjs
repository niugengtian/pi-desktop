import assert from "node:assert/strict";
import { test } from "node:test";
import { taskMemorySource, updateTaskMemory } from "./task-memory.mjs";
import { createLocalMemoryRunner, isLoopbackModel } from "./local-model.mjs";

const context = (history) => [
  { role: "system", content: "SECRET_SYSTEM" },
  ...history,
  { role: "user", content: "Current request" },
];

test("extracts effective completed context for any provider without forwarding system or current request", () => {
  const source = taskMemorySource(
    context([
      { role: "user", content: "Goal" },
      { role: "toolResult", content: [{ type: "text", text: "Tool finding" }] },
      { role: "compactionSummary", summary: "Prior task decision" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THOUGHT" },
          { type: "text", text: "Progress" },
        ],
        stopReason: "stop",
      },
    ]),
  );
  for (const value of ["Goal", "Tool finding", "Prior task decision", "Progress"]) assert.ok(source.includes(value));
  for (const value of ["SECRET_SYSTEM", "SECRET_THOUGHT", "Current request"]) assert.ok(!source.includes(value));
});

test("main success, incremental update, and disabled switch", async () => {
  const calls = [];
  const settings = { enabled: true, primary: "local/main", fallback: "local/backup" };
  const run = async (id) => {
    calls.push(id);
    return "目标：继续任务";
  };
  const first = await updateTaskMemory(context([{ role: "user", content: "Goal" }]), settings, run);
  assert.deepEqual(calls, ["local/main"]);
  const cached = await updateTaskMemory(
    context([{ role: "user", content: "Goal" }]),
    settings,
    () => {
      throw Error("unexpected call");
    },
    first,
  );
  assert.equal(cached, first);
  const next = await updateTaskMemory(
    context([
      { role: "user", content: "Goal" },
      { role: "assistant", content: "Progress" },
    ]),
    settings,
    run,
    first,
  );
  assert.equal(next.modelId, "local/main");
  assert.equal(calls.length, 2);
  assert.equal(await updateTaskMemory(context([]), { ...settings, enabled: false }, run), null);
});

test("main failure alerts then backup succeeds, double failure never returns memory", async () => {
  const failures = [];
  const settings = { enabled: true, primary: "local/main", fallback: "local/backup" };
  const source = context([{ role: "user", content: "Goal" }]);
  const summary = await updateTaskMemory(
    source,
    settings,
    async (id) => {
      if (id === "local/main") throw Error("offline");
      return "目标：完成";
    },
    null,
    (id) => failures.push(id),
  );
  assert.deepEqual(failures, ["local/main"]);
  assert.equal(summary.modelId, "local/backup");
  await assert.rejects(
    updateTaskMemory(source, settings, () => {
      throw Error("offline");
    }),
    /All configured memory models failed/,
  );
});

test("over-budget input and output stop without truncation", async () => {
  const settings = { enabled: true, primary: "local/main", fallback: null };
  await assert.rejects(
    updateTaskMemory(context([{ role: "user", content: "x".repeat(120_001) }]), settings, () => "summary"),
    /exceeds/,
  );
  await assert.rejects(
    updateTaskMemory(context([{ role: "user", content: "short" }]), settings, () => "x".repeat(4_001)),
    /All configured memory models failed/,
  );
});

test("runner probes once and rejects non-loopback before touching credentials", async () => {
  assert.equal(isLoopbackModel({ baseUrl: "https://openai.com/v1" }), false);
  assert.equal(isLoopbackModel({ baseUrl: "http://127.0.0.1:11434/v1" }), true);
  const calls = [];
  const runner = await createLocalMemoryRunner({
    runtime: {
      getModel: () => ({ baseUrl: "http://127.0.0.1:11434/v1" }),
      getAuth: async () => true,
      completeSimple: async (_model, input) => {
        calls.push(input.messages[0].content);
        return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
      },
    },
  });
  await runner("local/main", "First chunk");
  await runner("local/main", "Second chunk");
  assert.equal(calls.length, 3);
  assert.match(calls[0], /Reply with OK/);
});
