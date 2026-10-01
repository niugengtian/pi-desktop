import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TIERED_BUDGET,
  estimateEnvelope,
  planWireBudget,
  enforceWireBudget,
  nativeBudgetHints,
} from "./tiered-budget.mjs";

const model = {
  id: "fictional",
  provider: "fixture",
  api: "openai-completions",
  contextWindow: 32768,
  maxTokens: 2048,
};
const payload = (messages = [{ role: "user", content: "Fictional current request" }]) => ({
  model: model.id,
  messages: [{ role: "system", content: "Fictional protocol" }, ...messages],
  max_completion_tokens: 2048,
});

test("invalid policy arithmetic refuses instead of turning NaN or unsafe limits into an allow", () => {
  assert.throws(
    () => planWireBudget(payload(), model, { policy: { ...TIERED_BUDGET, safety: NaN } }),
    /invalid-budget-policy/,
  );
  assert.throws(
    () => nativeBudgetHints([], { ...model, contextWindow: Number.MAX_SAFE_INTEGER }, () => 0),
    /invalid-model-budget/,
  );
});

test("measurement is explicit conservative estimate, never SDK chars/4 or exact token count", () => {
  const measurement = estimateEnvelope({ text: "月亮图书馆" }, 1);
  assert.equal(measurement.accuracy, "conservative-estimate-not-token-count");
  assert.equal(measurement.wireBytes, Buffer.byteLength(JSON.stringify({ text: "月亮图书馆" })));
  assert.equal(measurement.estimatedTokens, measurement.wireBytes + 32);
  assert.match(measurement.assumptions, /not officially calibrated/);
});
test("window allocation subtracts actual system/schema, output and safety before hot allowance", () => {
  const body = {
    ...payload(),
    tools: [
      { type: "function", function: { name: "fictional_tool", description: "Schema ".repeat(100), parameters: {} } },
    ],
  };
  const report = planWireBudget(body, { ...model, contextWindow: 6000 });
  assert.equal(report.action, "allow");
  assert.equal(report.outputReserved, 2048);
  assert.equal(report.inputAllowance, 6000 - 2048 - TIERED_BUDGET.safety);
  assert.ok(report.hotAllowance < 6000 - 2048 - TIERED_BUDGET.safety);
  assert.equal(report.hotTarget, report.hotAllowance);
  assert.equal(report.protocolEstimate.accuracy, "conservative-estimate-not-token-count");
});
test("large current request refuses without slicing; large protocol/schema cannot consume hidden budget", () => {
  const body = payload([{ role: "user", content: "Fictional ".repeat(1800) }]);
  const original = JSON.stringify(body);
  assert.throws(() => enforceWireBudget(body, model), /hot-envelope-limit/);
  assert.equal(JSON.stringify(body), original);
  const schema = {
    ...payload(),
    tools: [{ type: "function", function: { name: "fictional", description: "x".repeat(5000), parameters: {} } }],
  };
  assert.throws(() => enforceWireBudget(schema, { ...model, contextWindow: 5000 }), /input-window-reservation/);
});
test("native warm is present exactly once and bounded; uncovered increment remains hot", () => {
  const warmText = "Fictional native summary; planned, not completed.";
  const body = payload([
    { role: "user", content: [{ type: "text", text: warmText }] },
    { role: "user", content: "Uncovered exact 17" },
  ]);
  const report = enforceWireBudget(body, model, { warmText });
  assert.equal(report.action, "allow");
  assert.ok(report.warmEstimate.estimatedTokens > 0);
  assert.throws(() => enforceWireBudget(payload(), model, { warmText }), /native-warm-missing/);
  assert.throws(
    () => enforceWireBudget(payload([...body.messages.slice(1), body.messages[1]]), model, { warmText }),
    /duplicated/,
  );
  const largeWarm = "w".repeat(4500);
  assert.throws(
    () => enforceWireBudget(payload([{ role: "user", content: largeWarm }]), model, { warmText: largeWarm }),
    /warm-envelope-limit/,
  );
});
test("whole tool chains fit or stop; orphan/pending tool results are never dropped or invented", () => {
  const call = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "f1", type: "function", function: { name: "fictional_read", arguments: "{}" } }],
  };
  const result = { role: "tool", tool_call_id: "f1", content: "Fictional tool result" };
  assert.equal(enforceWireBudget(payload([call, result]), model).action, "allow");
  assert.throws(() => enforceWireBudget(payload([call]), model), /unfinished-tool-chain/);
  assert.throws(() => enforceWireBudget(payload([result]), model), /orphan-tool-result/);
  assert.throws(
    () => enforceWireBudget(payload([call, { ...result, content: "x".repeat(18000) }]), model),
    /hot-envelope-limit/,
  );
});
test("unsupported images, API, output limits and lost protocol fail closed", () => {
  assert.throws(
    () =>
      enforceWireBudget(
        payload([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]),
        model,
      ),
    /media-or-unsupported/,
  );
  assert.throws(() => enforceWireBudget(payload(), { ...model, api: "openai-responses" }), /unsupported/);
  assert.throws(() => enforceWireBudget({ ...payload(), max_tokens: 4 }, model), /invalid-output/);
  assert.throws(() => enforceWireBudget({ ...payload(), max_completion_tokens: 9999 }, model), /invalid-output/);
  assert.throws(
    () => enforceWireBudget({ ...payload(), messages: [{ role: "user", content: "No system" }] }, model),
    /leading-protocol/,
  );
});
test("native scheduler hint retains latest complete user span even when oversized", () => {
  const messages = [
    { role: "system", content: "Protocol" },
    { role: "user", content: "Earlier ".repeat(500) },
    { role: "assistant", content: [{ type: "text", text: "Ack" }] },
    { role: "user", content: "Current ".repeat(2500) },
    { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "fictional", arguments: {} }] },
  ];
  const sdkEstimate = (message) => Math.ceil(JSON.stringify(message).length / 4);
  const hint = nativeBudgetHints(messages, model, sdkEstimate);
  assert.equal(hint.needsNativeCompaction, false);
  assert.ok(hint.keepRecentTokens >= messages.slice(3).reduce((sum, message) => sum + sdkEstimate(message), 0));
  assert.equal(hint.reserveTokens, model.contextWindow + 1);
  assert.throws(
    () => nativeBudgetHints([{ role: "user", content: [{ type: "image", data: "AA==" }] }], model, sdkEstimate),
    /unsupported-native-content/,
  );
});
