import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { planWireBudget, estimateEnvelope } from "./tiered-budget.mjs";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const refuse = () => {
  throw new Error("TIERED_POLICY_REFUSED: unsupported-or-unmeasured-codex-item");
};
/** Actual Codex serialization (possibly zstd), exact endpoint and approved body; never inspect auth headers. */
export function checkCodexDispatch(url, body, model, expectedPayload) {
  const base = new URL(model.baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.origin !== "https://chatgpt.com" && !(base.protocol === "http:" && base.hostname === "127.0.0.1"))
  )
    refuse();
  const normalized = model.baseUrl.trim().replace(/\/+$/, "");
  const endpoint = normalized.endsWith("/codex/responses")
    ? normalized
    : normalized.endsWith("/codex")
      ? normalized + "/responses"
      : normalized + "/codex/responses";
  if (String(url) !== endpoint || !expectedPayload) refuse();
  let bytes;
  if (typeof body === "string") bytes = Buffer.from(body);
  else if (body instanceof Uint8Array) bytes = Buffer.from(body);
  else refuse();
  if (bytes.length > 8 * 1024 * 1024) refuse();
  if (bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])))
    bytes = zstdDecompressSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  if (bytes.toString("utf8") !== expectedPayload) refuse();
}
/** Opaque bytes are NOT tokenized. Reserve provider-reported output + reasoning per replay item. */
export function nativeBudgetView(messages) {
  const opaque = new Map();
  let opaqueReserved = 0;
  const safe = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (!block.thinkingSignature) return block;
        if (
          message.role !== "assistant" ||
          message.api !== "openai-codex-responses" ||
          block.type !== "thinking" ||
          block.redacted
        )
          refuse();
        let item;
        try {
          item = JSON.parse(block.thinkingSignature);
        } catch {
          refuse();
        }
        const output = message.usage?.output;
        const reasoning = message.usage?.reasoning ?? 0;
        if (
          item?.type !== "reasoning" ||
          typeof item.id !== "string" ||
          !item.id ||
          !Number.isSafeInteger(output) ||
          output <= 0 ||
          !Number.isSafeInteger(reasoning) ||
          reasoning < 0
        )
          refuse();
        const reserved = output + reasoning;
        if (!Number.isSafeInteger(reserved) || opaque.has(hash(item))) refuse();
        opaque.set(hash(item), reserved);
        opaqueReserved += reserved;
        if (!Number.isSafeInteger(opaqueReserved)) refuse();
        return { type: "thinking", thinking: block.thinking ?? "", opaqueReplayReserved: reserved };
      }),
    };
  });
  return { messages: safe, opaque, opaqueReserved };
}
/** Inspection only: never return this synthetic Completions view to the provider. */
export function planCodexBudget(payload, model, { nativeMessages = [], warmText, operation = "chat", policy } = {}) {
  if (
    model.api !== "openai-codex-responses" ||
    payload?.model !== model.id ||
    payload.store !== false ||
    payload.stream !== true ||
    typeof payload.instructions !== "string" ||
    !payload.instructions.trim() ||
    !Array.isArray(payload.input) ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0
  )
    refuse();
  const supportedKeys = new Set([
    "model",
    "store",
    "stream",
    "instructions",
    "input",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "include",
    "prompt_cache_key",
    "service_tier",
  ]);
  if (Object.keys(payload).some((key) => !supportedKeys.has(key))) refuse();
  if (
    payload.max_output_tokens !== undefined ||
    payload.max_tokens !== undefined ||
    payload.max_completion_tokens !== undefined ||
    payload.previous_response_id ||
    payload.conversation
  )
    refuse();
  if (
    payload.tools !== undefined &&
    (!Array.isArray(payload.tools) || payload.tools.some((tool) => !["function", "custom"].includes(tool.type)))
  )
    refuse();
  const { opaque } = nativeBudgetView(nativeMessages);
  let opaqueReserved = 0;
  const seenOpaque = new Set();
  const messages = [{ role: "system", content: payload.instructions }];
  const text = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) refuse();
    return content
      .map((part) => {
        if (!["input_text", "output_text", "text"].includes(part.type) || typeof part.text !== "string") refuse();
        return part.text;
      })
      .join("\n");
  };
  const sanitizedInput = payload.input.map((item) => {
    if (item.type === "reasoning") {
      const key = hash(item);
      const reserved = opaque.get(key);
      if (!reserved || seenOpaque.has(key)) refuse();
      seenOpaque.add(key);
      opaqueReserved += reserved;
      if (!Number.isSafeInteger(opaqueReserved)) refuse();
      return { type: "reasoning", id: item.id, opaqueReplayReserved: reserved };
    }
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      const argumentsText = item.type === "function_call" ? item.arguments : item.input;
      if (
        typeof item.call_id !== "string" ||
        !item.call_id ||
        typeof item.name !== "string" ||
        typeof argumentsText !== "string"
      )
        refuse();
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: argumentsText } };
      const prior = messages.at(-1);
      if (prior?.role === "assistant" && prior.tool_calls) prior.tool_calls.push(call);
      else messages.push({ role: "assistant", content: "", tool_calls: [call] });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      if (typeof item.call_id !== "string" || !item.call_id) refuse();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: text(item.output) });
    } else if (!item.type || item.type === "message") {
      if (!["user", "assistant", "system", "developer"].includes(item.role)) refuse();
      messages.push({ role: item.role, content: text(item.content) });
    } else refuse();
    return item;
  });
  // Codex adapter does NOT send an output cap. Reserve FULL model catalog maximum;
  // do not inject a backend-unsupported field or claim options.maxTokens capped it.
  const report = planWireBudget(
    { model: model.id, messages, tools: payload.tools, max_tokens: model.maxTokens },
    { ...model, api: "openai-completions" },
    { warmText, operation, policy },
  );
  const wireBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (wireBytes > 8 * 1024 * 1024) refuse();
  const measured = estimateEnvelope(
    { ...payload, input: sanitizedInput },
    payload.input.length,
    payload.tools?.length ?? 0,
  );
  report.totalEstimate = {
    ...measured,
    wireBytes,
    estimatedTokens: Math.max(measured.estimatedTokens, report.totalEstimate.estimatedTokens) + opaqueReserved,
    opaqueReserved,
    opaqueMeasurement: "provider-output-derived-replay-reservation-not-tokenizer",
  };
  report.hotEstimate.estimatedTokens += opaqueReserved;
  if (
    operation === "chat" &&
    report.hotEstimate.estimatedTokens > report.hotAllowance &&
    !report.reasons.includes("hot-envelope-limit")
  )
    report.reasons.push("hot-envelope-limit");
  report.model = `${model.provider}/${model.id}`;
  report.api = model.api;
  report.outputPolicy = "catalog-maximum-reserved-no-wire-cap";
  if (
    report.totalEstimate.estimatedTokens > report.inputAllowance &&
    !report.reasons.includes("input-window-reservation")
  )
    report.reasons.push("input-window-reservation");
  report.action = report.reasons.length ? "block" : "allow";
  return report;
}
