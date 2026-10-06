import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { planCodexBudget, nativeBudgetView, checkCodexDispatch } from "./tiered-codex-budget.mjs";

test("native signed reasoning remains on the wire without blocking text budget inspection", () => {
  for (const api of ["anthropic-messages", "google-generative-ai", "google-vertex", "bedrock-converse-stream"]) {
    const messages = [
      {
        role: "assistant",
        api,
        usage: { output: 32 },
        content: [{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "provider-signed-artifact" }],
      },
    ];
    const view = nativeBudgetView(messages);
    assert.equal(view.opaqueReserved, 32);
    assert.equal(view.messages[0].content[0].thinking, "visible reasoning");
    assert.equal(view.messages[0].content[0].thinkingSignature, undefined);
    assert.equal(messages[0].content[0].thinkingSignature, "provider-signed-artifact");
  }
});
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { nativeBudgetHints } from "./tiered-budget.mjs";
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
test("DeepSeek visible reasoning survives budget inspection and real SDK Codex conversion without opaque replay", () => {
  for (const signature of ["reasoning", "reasoning_content", "reasoning_text"]) {
    const native = [
      {
        role: "assistant",
        api: "openai-completions",
        provider: "deepseek",
        model: "fixture-flash",
        stopReason: "stop",
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "Fictional visible reasoning 17", thinkingSignature: signature },
          { type: "text", text: "Fictional completed result 23" },
        ],
      },
    ];
    const before = JSON.stringify(native);
    const view = nativeBudgetView(native);
    assert.equal(view.opaqueReserved, 0);
    assert.equal(view.messages[0].content[0].thinking, "Fictional visible reasoning 17");
    assert.equal(nativeBudgetHints(native, model, () => 10).needsNativeCompaction, false);
    const body = payload();
    body.input = convertResponsesMessages({ ...model, input: ["text"] }, { messages: native }, new Set());
    assert.ok(JSON.stringify(body.input).includes("Fictional visible reasoning 17"));
    assert.ok(!JSON.stringify(body.input).includes("thinkingSignature"));
    assert.equal(planCodexBudget(body, model, { nativeMessages: native }).action, "allow");
    assert.equal(JSON.stringify(native), before);
  }
});
test("Completions field markers never authorize opaque, redacted or malformed replay", () => {
  const message = { role: "assistant", api: "openai-completions", content: [] };
  const block = { type: "thinking", thinking: "Visible text", thinkingSignature: "reasoning_content" };
  for (const bad of [
    { ...block, redacted: true },
    { ...block, thinking: null },
    { ...block, thinkingSignature: "opaque-unknown" },
    { ...block, type: "text" },
  ])
    assert.throws(() => nativeBudgetView([{ ...message, content: [bad] }]), /unmeasured/);
  const body = payload();
  body.input.push({ type: "reasoning", id: "foreign", encrypted_content: "opaque" });
  assert.throws(
    () => planCodexBudget(body, model, { nativeMessages: [{ ...message, content: [block] }] }),
    /unmeasured/,
  );
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
test("Codex uses a planning reserve for catalogs whose output maximum fills the entire window", () => {
  const target = { ...model, contextWindow: 32768, maxTokens: 32768 };
  const report = planCodexBudget(payload(), target, { outputReservation: 8192 });
  assert.equal(report.action, "allow");
  assert.equal(report.outputPolicy, "planning-reservation-no-wire-cap");
  assert.equal(payload().max_output_tokens, undefined);
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
  for (const input of [[{ type: "item_reference", id: "unknown" }]])
    assert.throws(() => planCodexBudget({ ...payload(), input }, model), /unmeasured/);
  for (const update of [
    { store: true },
    { previous_response_id: "foreign" },
    { max_output_tokens: 1024 },
    { tools: [{ type: "web_search" }] },
    { foreign_server_state: "unknown" },
    { previous_response_id: "" },
  ])
    assert.throws(() => planCodexBudget({ ...payload(), ...update }, model), /unmeasured/);
});
