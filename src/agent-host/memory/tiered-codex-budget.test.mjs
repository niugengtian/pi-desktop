import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { planCodexBudget, nativeBudgetView, checkCodexDispatch } from "./tiered-codex-budget.mjs";
const model = {
  id: "fictional-sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  contextWindow: 32768,
  maxTokens: 4096,
};
const payload = () => ({
  model: model.id,
  store: false,
  stream: true,
  instructions: "Fictional system",
  input: [{ role: "user", content: [{ type: "input_text", text: "Fictional current input" }] }],
});
test("Codex protocol, full catalog output and whole tool chains are reserved without inventing a wire output cap", () => {
  const body = payload();
  body.tools = [{ type: "function", name: "fictional_read", parameters: { type: "object" } }];
  body.input.push(
    { type: "function_call", call_id: "fixture17", name: "fictional_read", arguments: "{}" },
    { type: "function_call_output", call_id: "fixture17", output: "Fictional result17" },
  );
  const report = planCodexBudget(body, model);
  assert.equal(report.action, "allow");
  assert.equal(report.outputReserved, 4096);
  assert.equal(report.outputPolicy, "catalog-maximum-reserved-no-wire-cap");
  assert.ok(!Object.hasOwn(body, "max_output_tokens"));
  body.input.pop();
  assert.throws(() => planCodexBudget(body, model), /unfinished-tool-chain/);
});
test("Codex simultaneous tool calls remain one protected batch, not separate unfinished messages", () => {
  const body = payload();
  body.input.push(
    { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
    { type: "function_call", call_id: "call_b", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_b", output: "second" },
    { type: "function_call_output", call_id: "call_a", output: "first" },
  );
  assert.equal(planCodexBudget(body, model).action, "allow");
});
test("actual zstd/plain dispatch matches the approved payload and exact target, with no alternate or redirect endpoint", () => {
  const target = { ...model, baseUrl: "https://chatgpt.com/backend-api" },
    body = JSON.stringify(payload());
  const url = "https://chatgpt.com/backend-api/codex/responses";
  checkCodexDispatch(url, body, target, body);
  checkCodexDispatch(url, zstdCompressSync(body), target, body);
  for (const [changedUrl, changedBody] of [
    [url + "?foreign=1", body],
    ["https://foreign.invalid/codex/responses", body],
    [url, body + " "],
  ])
    assert.throws(() => checkCodexDispatch(changedUrl, changedBody, target, body), /unmeasured/);
});
test("opaque replay uses bound prior reported output; never base64 bytes as token count; unknown artifacts refuse", () => {
  const item = { type: "reasoning", id: "rs17", summary: [], encrypted_content: "x".repeat(100000) };
  const native = [
    {
      role: "assistant",
      api: model.api,
      usage: { output: 70, reasoning: 20 },
      content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) }],
    },
  ];
  const body = payload();
  body.input.unshift(item);
  const report = planCodexBudget(body, model, { nativeMessages: native });
  assert.equal(report.totalEstimate.opaqueReserved, 90);
  assert.ok(report.totalEstimate.wireBytes > 100000);
  assert.ok(report.totalEstimate.estimatedTokens < 2000);
  assert.throws(() => planCodexBudget(body, model), /unmeasured/);
  assert.throws(() => nativeBudgetView([{ ...native[0], usage: { output: 0 } }]), /unmeasured/);
});
test("Codex media/references/server-side state, bad protocol and mutation of output reservation fail closed", () => {
  for (const input of [
    [{ type: "item_reference", id: "unknown" }],
    [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,fake" }] }],
  ])
    assert.throws(() => planCodexBudget({ ...payload(), input }, model), /unmeasured/);
  for (const update of [
    { store: true },
    { instructions: "" },
    { previous_response_id: "foreign" },
    { max_output_tokens: 1024 },
    { tools: [{ type: "web_search" }] },
    { foreign_server_state: "unknown" },
    { previous_response_id: "" },
  ])
    assert.throws(() => planCodexBudget({ ...payload(), ...update }, model), /unmeasured/);
});
