import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

export const TIERED_BUDGET = Object.freeze({
  hotTarget: 8000,
  hotMax: 12000,
  warmTarget: 2000,
  warmMax: 4000,
  safety: 1024,
});

const fail = (reason) => {
  throw new Error(`TIERED_POLICY_REFUSED: ${reason}`);
};
const integer = (value) => Number.isSafeInteger(value) && value > 0;
function validatePolicy(policy) {
  if (
    !["hotTarget", "hotMax", "warmTarget", "warmMax", "safety"].every((key) => integer(policy[key])) ||
    policy.hotTarget > policy.hotMax ||
    policy.warmTarget > policy.warmMax
  )
    fail("invalid-budget-policy");
}

/** Not a tokenizer. Byte-level BPE text envelope plus explicit framing allowance.
 * Includes JSON syntax/metadata that may not tokenize at all: intentionally early refusal.
 * Applicable only under the caller's explicit byte-BPE/text protocol contract.
 */
export function estimateEnvelope(value, messageCount = 0, toolCount = 0) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") fail("invalid-envelope");
  const wireBytes = Buffer.byteLength(serialized, "utf8");
  if (wireBytes > 8 * 1024 * 1024) fail("measurement-size-limit");
  return {
    method: "byte-bpe-json-envelope-plus-framing",
    accuracy: "conservative-estimate-not-token-count",
    wireBytes,
    estimatedTokens: wireBytes + 32 * messageCount + 128 * toolCount,
    assumptions: "text-only byte-level BPE; provider framing allowance is not officially calibrated",
  };
}
export function wireText(message) {
  if (typeof message.content === "string") return message.content;
  if (message.content == null) return "";
  if (!Array.isArray(message.content)) fail("unsupported-content");
  return message.content
    .map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") fail("media-or-unsupported-content");
      return block.text;
    })
    .join("\n");
}
function checkChain(messages) {
  const pending = new Set();
  const seen = new Set();
  for (const message of messages) {
    wireText(message);
    if (!new Set(["system", "developer", "user", "assistant", "tool"]).has(message.role)) fail("unsupported-role");
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.role !== "assistant"))
      fail("invalid-tool-calls");
    for (const call of message.tool_calls ?? []) {
      if (
        typeof call.id !== "string" ||
        !call.id ||
        seen.has(call.id) ||
        call.type !== "function" ||
        typeof call.function?.arguments !== "string"
      )
        fail("invalid-tool-call-identity");
      seen.add(call.id);
      pending.add(call.id);
    }
    if (message.role === "tool" && !pending.delete(message.tool_call_id)) fail("orphan-tool-result");
  }
  if (pending.size) fail("unfinished-tool-chain");
}

/** Validate the FINAL OpenAI-completions JSON, after existing payload transforms. */
export function planWireBudget(payload, model, { warmText, operation = "chat", policy = TIERED_BUDGET } = {}) {
  validatePolicy(policy);
  if (!model || model.api !== "openai-completions" || !integer(model.contextWindow))
    fail("unsupported-model-window-or-api");
  if (!payload || payload.model !== model.id || !Array.isArray(payload.messages)) fail("payload-model-or-messages");
  if (payload.messages[0]?.role !== "system" && payload.messages[0]?.role !== "developer")
    fail("missing-leading-protocol");
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) fail("invalid-tool-schema-list");
  checkChain(payload.messages);
  const fields = ["max_tokens", "max_completion_tokens"].filter((key) => payload[key] !== undefined);
  if (
    fields.length !== 1 ||
    !integer(payload[fields[0]]) ||
    !integer(model.maxTokens) ||
    payload[fields[0]] > model.maxTokens
  )
    fail("invalid-output-reservation");
  const outputReserved = payload[fields[0]];
  const protocol = payload.messages.filter((message) => message.role === "system" || message.role === "developer");
  const conversation = payload.messages.filter((message) => message.role !== "system" && message.role !== "developer");
  const warm = warmText
    ? conversation.filter((message) => message.role === "user" && wireText(message) === warmText)
    : [];
  if (operation === "chat" && warmText && warm.length !== 1) fail("native-warm-missing-or-duplicated");
  const hot = conversation.filter((message) => !warm.includes(message));
  const protocolEstimate = estimateEnvelope(
    { messages: protocol, tools: payload.tools ?? [] },
    protocol.length,
    payload.tools?.length ?? 0,
  );
  const warmEstimate = estimateEnvelope(warm, warm.length);
  const hotEstimate = estimateEnvelope(hot, hot.length);
  const totalEstimate = estimateEnvelope(payload, payload.messages.length, payload.tools?.length ?? 0);
  const inputAllowance = model.contextWindow - outputReserved - policy.safety;
  const hotAllowance = Math.max(
    0,
    Math.min(policy.hotMax, inputAllowance - protocolEstimate.estimatedTokens - warmEstimate.estimatedTokens),
  );
  const reasons = [];
  if (totalEstimate.estimatedTokens > inputAllowance) reasons.push("input-window-reservation");
  if (operation === "chat" && warmEstimate.estimatedTokens > policy.warmMax) reasons.push("warm-envelope-limit");
  if (operation === "chat" && hotEstimate.estimatedTokens > hotAllowance) reasons.push("hot-envelope-limit");
  return {
    operation,
    model: `${model.provider}/${model.id}`,
    action: reasons.length ? "block" : "allow",
    reasons,
    window: model.contextWindow,
    outputReserved,
    safetyReserved: policy.safety,
    inputAllowance,
    hotTarget: Math.min(policy.hotTarget, hotAllowance),
    hotAllowance,
    warmTarget: policy.warmTarget,
    warmAllowance: policy.warmMax,
    protocolEstimate,
    warmEstimate,
    hotEstimate,
    totalEstimate,
  };
}
export function enforceWireBudget(payload, model, options) {
  const report = planWireBudget(payload, model, options);
  if (report.action !== "allow") fail(report.reasons.join(","));
  return report;
}

/** SDK preparation hints, not an alternate message slicer or exact token calculation. */
export function nativeBudgetHints(messages, model, sdkEstimate, policy = TIERED_BUDGET) {
  validatePolicy(policy);
  if (!integer(model.contextWindow) || !integer(model.contextWindow + 1) || !integer(model.maxTokens))
    fail("invalid-model-budget");
  const protocol = [
    { role: "system", content: getCurrentSystemPrompt(messages), toolsAdded: getCurrentTools(messages) },
  ];
  const warm = messages.filter((message) => message.role === "compactionSummary");
  const hot = messages.filter((message) => message.role !== "system" && message.role !== "compactionSummary");
  // Original signatures/images can have non-text token semantics: do not infer tokens from base64.
  for (const message of messages)
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "image" || (block.type !== "text" && block.type !== "toolCall" && block.type !== "thinking"))
        fail("unsupported-native-content");
      if (block.type === "thinking" && (block.thinkingSignature || block.redacted)) fail("opaque-thinking-content");
    }
  const protocolEstimate = estimateEnvelope(protocol, protocol.length).estimatedTokens;
  const warmEstimate = warm.length ? estimateEnvelope(warm, warm.length).estimatedTokens : 0;
  const hotEstimate = estimateEnvelope(hot, hot.length).estimatedTokens;
  const available = Math.max(
    0,
    model.contextWindow - model.maxTokens - policy.safety - protocolEstimate - warmEstimate,
  );
  const hotTarget = Math.min(policy.hotTarget, available);
  let latestUser = -1;
  for (let index = 0; index < hot.length; index++) if (hot[index].role === "user") latestUser = index;
  const protectedSpan = latestUser < 0 ? hot : hot.slice(latestUser);
  const latestSpanSdkEstimate = protectedSpan.reduce((sum, message) => sum + sdkEstimate(message), 0);
  let suffixStart = Math.max(0, latestUser);
  // Hint whole user spans to the SDK. Do not let its backwards >= threshold include
  // a huge older user message merely because it overshoots the nominal retention target.
  for (let index = suffixStart - 1; index >= 0; index--) {
    if (hot[index].role !== "user") continue;
    const candidate = hot.slice(index);
    if (estimateEnvelope(candidate, candidate.length).estimatedTokens > hotTarget) break;
    suffixStart = index;
  }
  const suffixSdkEstimate = hot.slice(suffixStart).reduce((sum, message) => sum + sdkEstimate(message), 0);
  return {
    measurement: "conservative-native-json-envelope; SDK cut hint is separately chars/4, not exact",
    needsNativeCompaction:
      hotEstimate > hotTarget &&
      estimateEnvelope(protectedSpan, protectedSpan.length).estimatedTokens <= Math.min(available, policy.hotMax) &&
      warmEstimate <= policy.warmMax,
    hotTarget,
    hotEstimate,
    protocolEstimate,
    warmEstimate,
    // Always preserve the latest user span even when it cannot fit. Final dispatch then refuses it.
    keepRecentTokens: Math.max(1, suffixSdkEstimate, latestSpanSdkEstimate),
    // Force SDK's own scheduler even when last usage is zero; this is a trigger sentinel,
    // not the output reservation. Actual output is capped independently at final dispatch.
    reserveTokens: model.contextWindow + 1,
  };
}
