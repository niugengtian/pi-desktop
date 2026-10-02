import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTieredWebPlan, checkWebDispatch, checkWebReceipt, WEB_CONTRACT } from "./tiered-web.mjs";
import { tieredHash } from "./tiered-workspace.mjs";
const model = (id) => ({
  provider: "opencli-page",
  api: "opencli-page",
  baseUrl: "page-provider://local",
  id,
  contextWindow: 128000,
  maxTokens: 16384,
});
const snapshot = () => ({
  identity: { sessionId: "fictional-task", sourceHash: "a".repeat(64) },
  warm: { version: "warm-v1", summary: "蓝鲸47，蓝色。旧计划3箱，未执行。" },
  projectedContext: [],
  pendingToolCallIds: [],
  hot: [
    { sourceEntryId: "u1", message: { role: "user", content: "Long preserved text " + "x".repeat(2100) } },
    {
      sourceEntryId: "a1",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "PRIVATE_SIGNATURE" },
          {
            type: "toolCall",
            id: "call1",
            name: "read",
            arguments: { path: "fictional.txt" },
            thoughtSignature: "PRIVATE_TOOL_SIGNATURE",
          },
        ],
      },
    },
    {
      sourceEntryId: "r1",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "已读≠已修改；只是计划。" }],
      },
    },
    { sourceEntryId: "u2", message: { role: "user", content: "计划改4箱，尚未执行。当前是什么？" } },
  ],
  files: { "cool/history.jsonl": "PRIVATE_COLD" },
});
test("all three targets serialize the SAME full visible projection, no recent-only/handoff cut", () => {
  const plans = ["chatgpt-web", "deepseek-chat", "deepseek-reasoner"].map((id) =>
    buildTieredWebPlan(snapshot(), model(id)),
  );
  assert.equal(new Set(plans.map((p) => p.payload.text)).size, 1);
  for (const p of plans) {
    assert.match(p.payload.text, /x{2100}/);
    assert.match(p.payload.text, /计划改4箱/);
    assert.match(p.payload.text, /已读≠已修改/);
    assert.match(p.payload.text, /"toolCallId":"call1"/);
    assert.doesNotMatch(p.payload.text, /PRIVATE_|PI TASK HANDOFF|summary truncated|Previous user text exceeds/);
    assert.equal(p.omittedThinking, 1);
    assert.equal(p.payload.hotSourceEntryIds.length, 4);
    assert.equal(p.report.outputCapEnforced, false);
    assert.equal(p.report.websiteWindowMeasured, false);
    assert.equal(p.report.algorithm, "conservative-estimate-not-token-count");
  }
  assert.equal(plans[2].payload.mode, "reasoner");
});
test("media, pending tools, unknown roles and nonfitting FULL hot/warm refuse, never truncate", () => {
  for (const mutate of [
    (s) => s.pendingToolCallIds.push("pending"),
    (s) => (s.hot[0].message.content = [{ type: "image", mimeType: "image/png", data: "AA==" }]),
    (s) => (s.hot[0].message.role = "unknown"),
    (s) => (s.hot[0].message.content = "x".repeat(15000)),
    (s) => (s.warm.summary = "x".repeat(5000)),
  ]) {
    const s = snapshot();
    mutate(s);
    assert.throws(() => buildTieredWebPlan(s, model("chatgpt-web")), /TIERED_POLICY_REFUSED/);
  }
});
test("final NDJSON text/route and exact correlated receipt are validated", () => {
  const p = buildTieredWebPlan(snapshot(), model("chatgpt-web")).payload;
  const req = {
    id: "turn1",
    method: "turn.send",
    params: {
      text: p.text,
      attachments: [],
      mode: p.mode,
      site: p.site,
      dedupe: false,
      newConversation: true,
      deliveryContract: WEB_CONTRACT,
    },
  };
  assert.equal(checkWebDispatch(req, p), "turn1");
  for (const bad of [
    { ...req, params: { ...req.params, text: p.text + "mutated" } },
    { ...req, params: { ...req.params, newConversation: false } },
  ])
    assert.throws(() => checkWebDispatch(bad, p), /mutated/);
  const markdown = "Real receipt fixture";
  const receipt = {
    schema: WEB_CONTRACT,
    turnId: "turn1",
    promptHash: p.promptHash,
    responseHash: tieredHash(markdown),
    evidence: "adapter-exact-prompt-pair",
    remote: { site: p.site, mode: p.mode, conversationId: "abc", conversationUrl: "https://chatgpt.com/c/abc" },
  };
  assert.deepEqual(checkWebReceipt(receipt, p, "turn1", markdown), receipt);
  for (const bad of [
    { ...receipt, turnId: "other" },
    { ...receipt, responseHash: "0".repeat(64) },
    { ...receipt, remote: { ...receipt.remote, conversationUrl: "https://evil.example/c/abc" } },
  ])
    assert.throws(() => checkWebReceipt(bad, p, "turn1", markdown), /TIERED_POLICY_REFUSED/);
});
