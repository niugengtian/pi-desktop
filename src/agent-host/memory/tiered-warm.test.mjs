import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, estimateTokens } from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { buildWarmPlan, validateWarmAnswer, readWarmRecord } from "./tiered-warm.mjs";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function fixture() {
  const manager = SessionManager.inMemory("/tmp/fictional-warm");
  const user = (content) => manager.appendMessage({ role: "user", content, timestamp: 1 });
  const assistant = () =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Fictional acknowledgement, not execution." }],
      api: "openai-completions",
      provider: "fictional",
      model: "a",
      stopReason: "stop",
      usage,
      timestamp: 2,
    });
  user("Fictional plan: rope → 3 boxes → deck; read 《云朵地图》 then 《纸船日记》. Not completed.");
  assistant();
  user("Fictional current span retained");
  assistant();
  const prepare = () => {
    const messages = manager.buildSessionProjection().messages;
    const latest = messages.findLastIndex((message) => message.role === "user");
    return prepareCompaction(manager.getBranch(), {
      enabled: true,
      reserveTokens: 2048,
      keepRecentTokens: messages.slice(latest).reduce((sum, message) => sum + estimateTokens(message), 0),
    });
  };
  const plan = buildWarmPlan(manager, prepare());
  const answer = (plan) =>
    JSON.stringify({
      sourceHash: plan.sourceHash,
      facts: plan.records
        .filter((record) => record.text.trim())
        .map((record) => ({ sourceId: record.sourceId, quote: record.text })),
    });
  return { manager, user, assistant, prepare, plan, answer };
}
test("completed tool data is quoted with error provenance; pending tools or images refuse instead of truncating", () => {
  const f = fixture();
  f.manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "fictional-call-17", name: "read", arguments: { path: "/tmp/fictional-file" } }],
    api: "openai-completions",
    provider: "fictional",
    model: "a",
    stopReason: "toolUse",
    usage,
    timestamp: 3,
  });
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "fictional-call-17",
    toolName: "read",
    isError: true,
    content: [{ type: "text", text: "Fictional failure 17; not completed" }],
    timestamp: 4,
  });
  f.user("Fictional kept after tool batch");
  f.assistant();
  const plan = buildWarmPlan(f.manager, f.prepare());
  const candidate = validateWarmAnswer(plan, f.answer(plan));
  assert.match(candidate.summary, /tool-error/);
  assert.ok(candidate.details.readFiles.includes("/tmp/fictional-file"));
  const pending = fixture();
  pending.manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "pending-17", name: "read", arguments: {} }],
    api: "openai-completions",
    provider: "fictional",
    model: "a",
    stopReason: "toolUse",
    usage,
    timestamp: 3,
  });
  pending.user("Fictional kept after pending tool");
  pending.assistant();
  assert.throws(() => buildWarmPlan(pending.manager, pending.prepare()), /retained/);
  const media = fixture();
  media.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user").message.content =
    [{ type: "image", data: "fictional", mimeType: "image/png" }];
  assert.throws(() => buildWarmPlan(media.manager, media.prepare()), /retained/);
});

test("explicit visible-task-only scope never sends reasoning text or encrypted signatures", () => {
  const f = fixture();
  const old = f.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
  old.message.content.unshift({
    type: "thinking",
    thinking: "hidden-virtual-summary-not-task-evidence",
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id: "rs_virtual",
      encrypted_content: "cipher-virtual-not-to-send",
    }),
  });
  const plan = buildWarmPlan(f.manager, f.prepare());
  assert.ok(plan.records.some((record) => record.omittedReasoning));
  assert.ok(!plan.payload.includes("cipher-virtual"));
  assert.ok(!plan.payload.includes("hidden-virtual"));
  const candidate = validateWarmAnswer(plan, f.answer(plan));
  assert.match(candidate.details.tieredWarm.deltaScope, /visible-task-text-only/);
});

test("native prepared prefix only; exclude current/system and map exact entry/message fingerprints", () => {
  const f = fixture();
  assert.throws(() => {
    f.plan.payload = "changed";
  }, TypeError);
  assert.ok(!f.plan.payload.includes("current span"));
  assert.equal(f.plan.records.length, 2);
  assert.equal(f.plan.records[0].role, "user");
  const candidate = validateWarmAnswer(f.plan, f.answer(f.plan));
  assert.match(candidate.summary, /Not completed/);
  assert.match(candidate.summary, /rope.*3 boxes.*deck/);
  assert.equal(candidate.firstKeptEntryId, f.plan.firstKeptEntryId);
  assert.equal(candidate.details.tieredWarm.review, "pending-review");
});
test("quote provenance, explicit numeric/title anchors, source coverage and order reject omissions/invention", () => {
  const f = fixture();
  const parsed = JSON.parse(f.answer(f.plan));
  for (const altered of [
    { ...parsed, sourceHash: "foreign" },
    { ...parsed, facts: [] },
    { ...parsed, facts: parsed.facts.slice(1) },
    { ...parsed, facts: [{ ...parsed.facts[0], quote: "Completed 3 boxes" }, parsed.facts[1]] },
    { ...parsed, facts: [{ ...parsed.facts[0], quote: "rope" }, parsed.facts[1]] },
    { ...parsed, facts: [...parsed.facts].reverse() },
  ])
    assert.throws(() => validateWarmAnswer(f.plan, JSON.stringify(altered)), /retained/);
});
test("second native compaction sends only newly covered delta; cumulative facts merged locally", () => {
  const f = fixture();
  const first = validateWarmAnswer(f.plan, f.answer(f.plan));
  first.details.tieredWarm.review = "human-approved-not-proven";
  f.manager.appendCompaction(first.summary, first.firstKeptEntryId, first.tokensBefore, first.details, true);
  f.user("Fictional newer kept span");
  f.assistant();
  const second = buildWarmPlan(f.manager, f.prepare());
  assert.equal(second.parent.version, 1);
  assert.ok(!second.payload.includes("云朵地图"));
  assert.ok(!second.payload.includes(first.summary));
  const result = validateWarmAnswer(second, f.answer(second));
  assert.equal(result.details.tieredWarm.version, 2);
  assert.match(result.summary, /云朵地图/);
  assert.match(result.summary, /current span retained/);
});
test("altered cuts/prepared messages, overlarge full source, unsupported media and corrupt prior facts refuse", () => {
  const f = fixture();
  const prep = f.prepare();
  assert.throws(() => buildWarmPlan(f.manager, { ...prep, messagesToSummarize: [] }), /retained/);
  assert.throws(() => buildWarmPlan(f.manager, { ...prep, firstKeptEntryId: "foreign" }), /retained/);
  assert.throws(
    () => readWarmRecord({ summary: "wrong", details: { tieredWarm: { schema: "pi-extractive-warm-1" } } }),
    /retained/,
  );
  const source = f.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
  source.message.content = "x".repeat(13000);
  assert.throws(() => buildWarmPlan(f.manager, f.prepare()), /retained/);
});
