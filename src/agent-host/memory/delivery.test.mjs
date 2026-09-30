import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTaskMemory } from "./compile.mjs";
import { prepareMemoryDelivery, WEB_HANDOFF_PROMPT } from "./delivery.mjs";
import { installMemoryRequestGuard } from "./request-guard.ts";
import { taskMemorySource } from "./task-memory.mjs";

const model = { id: "fixture", provider: "opencli-page", api: "opencli-page", contextWindow: 128000 };
const entry = (id, parentId, role, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00Z",
  message: { role, content: role === "assistant" ? [{ type: "text", text }] : text, stopReason: "stop" },
});
function fixture(root) {
  const entries = [
    entry("u", null, "user", "TASK: offline memory"),
    entry("a", "u", "assistant", "DECISION: use local summaries"),
  ];
  return {
    entries,
    branchLeafId: "a",
    sessionId: "fictional-delivery",
    root,
    settings: { enabled: true, primary: "local/fixture", fallback: null },
    run: async () => "Goal: offline memory. Decision: local summaries.",
  };
}
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = fixture(root);
  const compiled = await compileTaskMemory(options);
  const ledger = {
    id: compiled.record.id,
    tier: compiled.record.tier,
    path: compiled.path,
    hash: compiled.hash,
    cursor: compiled.cursor,
    branchCursor: compiled.branchCursor,
  };
  const context = {
    systemPrompt: "PRIVATE_ALTERNATE_SYSTEM",
    tools: [{ name: "PRIVATE_TOOL_DECLARATION", description: "Not for Web", parameters: {} }],
    messages: [
      { role: "system", content: "PRIVATE_SYSTEM_WITH_TOOLS" },
      { role: "user", content: "TASK: offline memory" },
      { role: "toolResult", content: "PRIVATE_RAW_TOOL" },
      { role: "assistant", content: [{ type: "text", text: "DECISION: use local summaries" }] },
      { role: "user", content: "Continue implementation", timestamp: 1 },
    ],
  };
  return { ...options, ledger, model, context, from: { provider: "api", modelId: "earlier" }, estimatedTokens: 10 };
}

test("Web receives exact approved bounded memory, not system/tools or duplicate hot text", async (t) => {
  const options = await setup(t);
  let shown;
  const result = await prepareMemoryDelivery({
    ...options,
    approve: async (preview) => {
      shown = preview;
      return true;
    },
  });
  const prompt = result.context.messages[1].content;
  assert.equal(prompt, shown.text);
  assert.equal(result.context.messages[0].content, WEB_HANDOFF_PROMPT);
  assert.ok(!JSON.stringify(result.context).includes("PRIVATE_"));
  assert.equal((prompt.match(/Goal: offline memory/g) ?? []).length, 1);
  assert.ok(!prompt.includes("TASK: offline memory")); // already covered by hot-tier summary
  assert.equal(result.receipt.requestText, "Continue implementation");
});

test("30 model switches keep one bounded snapshot and never re-summarize repeated transport wrappers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-switches-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = fixture(root);
  const entries = [];
  let parent = null,
    checkpoint = null,
    prompt = null,
    modelCalls = 0;
  const lengths = [];
  for (let i = 0; i < 30; i++) {
    const changed = {
      type: "model_change",
      id: `m${i}`,
      parentId: parent,
      timestamp: "2026-01-01T00:00:00Z",
      provider: "fixture",
      modelId: `SWITCH_NOISE_${i}`,
    };
    const user = entry(`u${i}`, changed.id, "user", prompt ?? "TASK: offline memory");
    const answer = entry(`a${i}`, user.id, "assistant", "DECISION: use local summaries");
    entries.push(changed, user, answer);
    parent = answer.id;
    const compiled = await compileTaskMemory({
      ...base,
      entries,
      branchLeafId: parent,
      hotChars: 0,
      checkpoint,
      run: async () => {
        modelCalls++;
        return "Goal: offline memory. Decision: local summaries.";
      },
    });
    const memory = { ...compiled.memory };
    delete memory.source;
    checkpoint = {
      id: compiled.record.id,
      tier: compiled.record.tier,
      path: compiled.path,
      hash: compiled.hash,
      cursor: compiled.cursor,
      branchCursor: compiled.branchCursor,
      memory,
    };
    const result = await prepareMemoryDelivery({
      ...base,
      entries,
      branchLeafId: parent,
      ledger: checkpoint,
      model: { ...model, id: `web-${i % 2}` },
      from: { provider: "api", modelId: "other" },
      estimatedTokens: 100,
      context: {
        messages: [
          ...entries.filter((item) => item.type === "message").map((item) => item.message),
          { role: "user", content: "Continue implementation" },
        ],
      },
      approve: async () => true,
    });
    prompt = result.context.messages[1].content;
    lengths.push(prompt.length);
    assert.equal((prompt.match(/\[PI APPROVED MEMORY HANDOFF v1\]/g) ?? []).length, 1);
    assert.equal((prompt.match(/Goal: offline memory/g) ?? []).length, 1);
    assert.ok(!prompt.includes("SWITCH_NOISE") && !prompt.includes("### Checkpoint"));
    assert.ok(!JSON.stringify(checkpoint).includes("appended"));
  }
  assert.equal(new Set(lengths).size, 1);
  assert.ok(modelCalls <= 2, `Repeated transport text caused ${modelCalls} model calls`);
});

test("repeated paragraphs are removed from derived model input, not from the request", () => {
  const original = `Unique goal.\n\n${"Repeated offline decision.\n\n".repeat(500)}Another distinct fact.`;
  const source = taskMemorySource([
    { role: "user", content: original },
    { role: "assistant", content: "Confirmed." },
    { role: "user", content: "Next" },
  ]);
  assert.equal((source.match(/Repeated offline decision/g) ?? []).length, 1);
  assert.ok(source.includes("Unique goal") && source.includes("Another distinct fact"));
  assert.equal((original.match(/Repeated offline decision/g) ?? []).length, 500);
});

test("an edit while the exact preview is open invalidates the approval", async (t) => {
  const options = await setup(t);
  await assert.rejects(
    prepareMemoryDelivery({
      ...options,
      approve: async () => {
        appendFileSync(join(options.root, options.ledger.path), "\nHuman edit during approval\n");
        return true;
      },
    }),
    /Memory changed/,
  );
});

test("same API/model under budget uses the unmodified Pi context without confirmation", async (t) => {
  const options = await setup(t);
  const apiModel = { ...model, provider: "api", api: "openai-completions" };
  const result = await prepareMemoryDelivery({
    ...options,
    model: apiModel,
    from: { provider: "api", modelId: "fixture" },
    approve: () => {
      throw Error("unexpected preview");
    },
  });
  assert.equal(result.context, options.context);
  assert.equal(result.plan.mode, "normal");
});

test("cancelled or stale memory never reaches the real model dispatcher", async (t) => {
  const options = await setup(t);
  let dispatches = 0;
  const runtime = {
    streamSimple: () => {
      dispatches++;
      throw Error("must not be called");
    },
  };
  installMemoryRequestGuard(
    runtime,
    async (target, context) =>
      (
        await prepareMemoryDelivery({
          ...options,
          model: target,
          context,
          approve: async () => false,
        })
      ).context,
  );
  const cancelled = await runtime.streamSimple(model, options.context).result();
  assert.match(cancelled.errorMessage, /cancelled/);
  assert.equal(dispatches, 0);
  await assert.rejects(
    prepareMemoryDelivery({
      ...options,
      ledger: { ...options.ledger, branchCursor: { fingerprint: "stale" } },
      approve: async () => true,
    }),
    /stale/,
  );
});

test("protocol wrappers, repeated turns and model-change entries cannot snowball memory", () => {
  const wrap = (request) =>
    `[PI TASK HANDOFF]\nOLD_SNAPSHOT\n[/PI TASK HANDOFF]\n\n## Current request\n[PI WEB CONTEXT]\nOLD_TURNS\n[/PI WEB CONTEXT]\n\n## Current request\n${request}`;
  const messages = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: wrap(wrap("Implement retrieval")) },
    { role: "assistant", content: "Retrieval ready" },
    { role: "user", content: "Implement retrieval" },
    { role: "assistant", content: "Retrieval ready" },
    { role: "user", content: "current request" },
  ];
  const source = taskMemorySource(messages);
  assert.ok(!source.includes("OLD_"));
  assert.ok(!source.includes("HANDOFF"));
  assert.equal((source.match(/Implement retrieval/g) ?? []).length, 1);
  assert.equal((source.match(/Retrieval ready/g) ?? []).length, 1);
});
