import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, estimateTokens } from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import {
  buildWarmPlan,
  validateWarmAnswer,
  readWarmRecord,
  LONG_WARM_SCHEMA,
  WARM_SCHEMA,
  SUMMARY_WARM_SCHEMA,
  splitWarmPlan,
  mergeWarmAnswers,
  WARM_SEGMENT_BYTES,
} from "./tiered-warm.mjs";
// Old persisted v1/v2 records stay readable and retain their original strict contract.
function legacyPlan(plan) {
  const schema = JSON.stringify(plan.records).length > 12000 ? LONG_WARM_SCHEMA : WARM_SCHEMA;
  return Object.freeze({ ...plan, schema });
}
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
  const plan = legacyPlan(buildWarmPlan(manager, prepare()));
  const answer = (plan) =>
    JSON.stringify({
      sourceHash: plan.sourceHash,
      facts: plan.records
        .filter((record) => record.text.trim())
        .map((record) => ({ sourceId: record.sourceId, quote: record.text })),
    });
  return { manager, user, assistant, prepare, plan, answer };
}
test("long-source warm requires explicit coverage and exact quotes; raw history and unresolved state survive", () => {
  const f = fixture();
  f.manager.getSessionFile = () => "/tmp/fictional-full-history.jsonl";
  f.user("Fictional log 17. ".repeat(1500) + "Final delivery is not completed.");
  f.assistant();
  f.user("Continue only the pending delivery, do not repeat completed effects.");
  f.assistant();
  const plan = legacyPlan(buildWarmPlan(f.manager, f.prepare()));
  assert.equal(plan.schema, LONG_WARM_SCHEMA);
  const selected = plan.records.find((record) => record.text.includes("Final delivery is not completed."));
  const answer = {
    sourceHash: plan.sourceHash,
    facts: [{ sourceId: selected.sourceId, quote: "Final delivery is not completed." }],
    omittedSourceIds: plan.records
      .filter((record) => record.sourceId !== selected.sourceId && record.text.trim())
      .map((record) => record.sourceId),
  };
  const before = JSON.stringify(f.manager.getEntries());
  const candidate = validateWarmAnswer(plan, JSON.stringify(answer));
  assert.match(candidate.summary, /Final delivery is not completed/);
  assert.match(candidate.summary, /indexed but not quoted/);
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
  for (const changed of [
    { ...answer, omittedSourceIds: [] },
    { ...answer, omittedSourceIds: [...answer.omittedSourceIds, selected.sourceId] },
    { ...answer, facts: [{ sourceId: selected.sourceId, quote: "Final delivery completed successfully." }] },
  ])
    assert.throws(() => validateWarmAnswer(plan, JSON.stringify(changed)), /retained/);
  candidate.details.tieredWarm.review = "human-approved-not-proven";
  assert.equal(readWarmRecord({ summary: candidate.summary, details: candidate.details }).schema, LONG_WARM_SCHEMA);
});
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
    content: [{ type: "text", text: "Fictional failure 17; not completed\nExit code: 1\nLiteral escape remains: \\n" }],
    timestamp: 4,
  });
  f.user("Fictional kept after tool batch");
  f.assistant();
  const plan = legacyPlan(buildWarmPlan(f.manager, f.prepare()));
  const candidate = validateWarmAnswer(plan, f.answer(plan));
  const toolRecord = plan.records.find((record) => record.role === "toolResult");
  assert.ok(toolRecord.text.includes("not completed\nExit code: 1"));
  assert.ok(toolRecord.text.includes("Literal escape remains: \\n"));
  const excerptAnswer = JSON.parse(f.answer(plan));
  excerptAnswer.facts.find((fact) => fact.sourceId === toolRecord.sourceId).quote =
    "Fictional failure 17; not completed\nExit code: 1\nLiteral escape remains: \\n";
  validateWarmAnswer(plan, JSON.stringify(excerptAnswer));
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
  const mediaPlan = buildWarmPlan(media.manager, media.prepare());
  assert.match(mediaPlan.payload, /original retained in cool/);
  assert.doesNotMatch(mediaPlan.payload, /"data"/);
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
  const plan = legacyPlan(buildWarmPlan(f.manager, f.prepare()));
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
  const second = legacyPlan(buildWarmPlan(f.manager, f.prepare()));
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

test("large incremental source is partitioned at closed tool boundaries and commits only a complete checked batch", () => {
  const f = fixture();
  f.manager.getSessionFile = () => "/tmp/fictional-full-history.jsonl";
  for (let i = 0; i < 10; i++) {
    f.user(`Fictional log ${i}. `.repeat(1200));
    f.assistant();
  }
  f.user("Current pending work remains hot.");
  f.assistant();
  const plan = legacyPlan(buildWarmPlan(f.manager, f.prepare()));
  const before = JSON.stringify(f.manager.getEntries());
  const segments = splitWarmPlan(plan);
  assert.ok(segments.length > 1);
  assert.deepEqual(
    segments.flatMap((s) => s.records),
    plan.records,
  );
  assert.equal(new Set(segments.flatMap((s) => s.records.map((r) => r.sourceId))).size, plan.records.length);
  for (const segment of segments) {
    assert.ok(Buffer.byteLength(segment.payload) <= WARM_SEGMENT_BYTES);
    assert.ok(segment.records.at(-1).closedTools);
    assert.equal(segment.parent, undefined);
  }
  const answers = segments.map((s) =>
    JSON.stringify({
      sourceHash: s.sourceHash,
      facts: [{ sourceId: s.records[0].sourceId, quote: s.records[0].text.slice(0, 20) }],
      omittedSourceIds: s.records
        .slice(1)
        .filter((r) => r.text.trim())
        .map((r) => r.sourceId),
    }),
  );
  const candidate = mergeWarmAnswers(plan, segments, answers);
  assert.equal(candidate.firstKeptEntryId, plan.firstKeptEntryId);
  assert.equal(candidate.details.tieredWarm.delta.length, plan.records.length);
  assert.throws(() => mergeWarmAnswers(plan, segments, answers.slice(1)), /retained/);
  assert.throws(() => mergeWarmAnswers(plan, [...segments].reverse(), answers), /retained/);
  const giant = { ...plan, records: [{ ...plan.records[0], text: "x".repeat(WARM_SEGMENT_BYTES) }] };
  giant.payload = JSON.stringify({ records: giant.records });
  assert.throws(() => splitWarmPlan(giant), /indivisible/);
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
});

test("incremental summaries paraphrase and drop chatter without enumerating records or numbers", () => {
  const f = fixture();
  const plan = buildWarmPlan(f.manager, f.prepare());
  assert.equal(plan.schema, SUMMARY_WARM_SCHEMA);
  const answer = { sourceHash: plan.sourceHash, summary: "搬运和阅读仍处于计划阶段，尚未执行。" };
  const before = JSON.stringify(f.manager.getEntries());
  const candidate = validateWarmAnswer(plan, JSON.stringify(answer));
  assert.match(candidate.summary, /尚未执行/);
  assert.ok(!candidate.summary.includes("acknowledgement"));
  assert.equal(candidate.details.tieredWarm.facts.length, 0);
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
  for (const bad of [
    { ...answer, sourceHash: "foreign" },
    { ...answer, summary: null },
    { ...answer, summary: "x".repeat(3601) },
  ]) {
    assert.throws(() => validateWarmAnswer(plan, JSON.stringify(bad)), /retained/);
  }
  assert.doesNotThrow(() => validateWarmAnswer(plan, JSON.stringify({ ...answer, summary: "" })));
  candidate.details.tieredWarm.review = "human-approved-not-proven";
  assert.equal(readWarmRecord(candidate).schema, SUMMARY_WARM_SCHEMA);
  assert.throws(() => readWarmRecord({ ...candidate, summary: candidate.summary + "tampered" }), /retained/);
  f.manager.appendCompaction(
    candidate.summary,
    candidate.firstKeptEntryId,
    candidate.tokensBefore,
    candidate.details,
    true,
  );
  f.user("New current message");
  f.assistant();
  const next = buildWarmPlan(f.manager, f.prepare());
  assert.ok(!next.payload.includes("云朵地图"));
  assert.ok(!next.payload.includes("搬运和阅读"));
  const updated = validateWarmAnswer(
    next,
    JSON.stringify({ sourceHash: next.sourceHash, summary: "新增进展待确认。" }),
  );
  assert.equal(updated.details.tieredWarm.version, 2);
  assert.match(updated.summary, /尚未执行/);
  assert.match(updated.summary, /新增进展/);
});

test("all summary segments must succeed before native boundary can advance; empty segments are allowed", () => {
  const f = fixture();
  f.manager.getSessionFile = () => "/tmp/fictional-source.jsonl";
  for (let i = 0; i < 8; i++) {
    f.user("redundant chatter ".repeat(1400));
    f.assistant();
  }
  f.user("Keep current instructions hot");
  f.assistant();
  const plan = buildWarmPlan(f.manager, f.prepare());
  const segments = splitWarmPlan(plan);
  assert.ok(segments.length > 1);
  const before = JSON.stringify(f.manager.getEntries());
  const answers = segments.map((s, i) =>
    JSON.stringify({ sourceHash: s.sourceHash, summary: i ? "" : "等待下一步任务。" }),
  );
  const candidate = mergeWarmAnswers(plan, segments, answers);
  assert.match(candidate.summary, /等待下一步/);
  assert.equal(candidate.details.tieredWarm.delta.length, plan.records.length);
  assert.throws(() => mergeWarmAnswers(plan, segments, answers.slice(1)), /retained/);
  assert.throws(() => mergeWarmAnswers(plan, [...segments].reverse(), answers), /retained/);
  assert.throws(() => mergeWarmAnswers(plan, segments, [...answers.slice(0, -1), "malformed"]), /retained/);
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
});

test("visible assistant failures enter warm source even when assistant content is empty", () => {
  const f = fixture();
  const message = f.manager.getBranch().find((e) => e.type === "message" && e.message.role === "assistant").message;
  message.content = [];
  message.stopReason = "error";
  message.errorMessage = "Codex SSE response headers timed out after 300000ms";
  const plan = buildWarmPlan(f.manager, f.prepare());
  assert.match(plan.payload, /Assistant response failed/);
  assert.match(plan.payload, /timed out after 300000ms/);
});

test("many completed records and file-operation paths can be summarized in bounded segments", () => {
  const f = fixture();
  f.manager.getSessionFile = () => "/tmp/fixture-large-history.jsonl";
  for (let i = 0; i < 140; i++) {
    f.user(`Historical useful fact ${i}.`);
    f.assistant();
  }
  f.user("Current request remains hot");
  f.assistant();
  const preparation = f.prepare();
  for (let i = 0; i < 140; i++) preparation.fileOps.read.add(`/tmp/fixture-file-${i}`);
  const plan = buildWarmPlan(f.manager, preparation);
  assert.ok(plan.records.length > 128);
  assert.ok(plan.readFiles.length > 128);
  assert.ok(splitWarmPlan(plan).every((segment) => Buffer.byteLength(segment.payload) <= WARM_SEGMENT_BYTES));
});
