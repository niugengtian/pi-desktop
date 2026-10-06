import {
  WARM_INSTRUCTIONS,
  LONG_WARM_SCHEMA,
  LONG_WARM_INSTRUCTIONS,
  WARM_SEGMENT_BYTES,
  SUMMARY_WARM_SCHEMA,
  SUMMARY_WARM_INSTRUCTIONS,
} from "./tiered-warm.mjs";
import { createHash } from "node:crypto";
import { planWireBudget } from "./tiered-budget.mjs";
export const WARM_TARGET = "deepseek/deepseek-flash @ https://api.deepseek.com (thinking disabled)";
/** Transport injection exists for isolated tests, never a fallback or selectable endpoint. */
export function createFlashWarmRunner({
  runtime,
  signal,
  authorized,
  transport = globalThis.fetch,
  onEvent = () => {},
}) {
  return async (plan) => {
    const summaryMode = plan.schema === SUMMARY_WARM_SCHEMA;
    const large = summaryMode || plan.schema === LONG_WARM_SCHEMA;
    const instructions = summaryMode
      ? SUMMARY_WARM_INSTRUCTIONS
      : plan.schema === LONG_WARM_SCHEMA
        ? LONG_WARM_INSTRUCTIONS
        : WARM_INSTRUCTIONS;
    const outputCap = large ? 4096 : 2048;
    let stage = "preflight";
    let status;
    let stopReason;
    let output;
    let dispatched = false;
    const allowed = () => !signal?.aborted && authorized();
    let model;
    const correctModel = (actual) =>
      actual?.id === "deepseek-flash" &&
      actual.provider === "deepseek" &&
      actual.api === "openai-completions" &&
      actual.baseUrl === "https://api.deepseek.com";
    const validate = (body, actual) => {
      if (
        !allowed() ||
        !correctModel(actual) ||
        body?.model !== "deepseek-flash" ||
        body.thinking?.type !== "disabled" ||
        Object.hasOwn(body, "reasoning_effort") ||
        body.tools ||
        body.functions ||
        (summaryMode && body.response_format?.type !== "json_object") ||
        !Number.isSafeInteger(body.max_tokens) ||
        body.max_tokens <= 0 ||
        body.max_tokens > outputCap ||
        body.messages?.length !== 2 ||
        body.messages[0].role !== "system" ||
        body.messages[0].content !== instructions ||
        body.messages[1].role !== "user" ||
        body.messages[1].content !== plan.payload
      )
        throw new Error("Warm payload refused");
      if (planWireBudget(body, actual, { operation: "native-compaction" }).action !== "allow")
        throw new Error("Warm window refused");
    };
    try {
      model = runtime.getModel("deepseek", "deepseek-flash");
      if (
        !allowed() ||
        !correctModel(model) ||
        !plan.payload ||
        Buffer.byteLength(plan.payload) > (large ? WARM_SEGMENT_BYTES : 12000) ||
        runtime.getRegisteredProviderConfig?.("deepseek")?.streamSimple ||
        runtime.getRegisteredNativeProvider?.("deepseek")
      )
        throw new Error("Warm target refused");
      const result = await runtime.completeSimple(
        model,
        {
          messages: [
            { role: "system", content: instructions, timestamp: 0 },
            { role: "user", content: plan.payload, timestamp: 0 },
          ],
        },
        {
          signal,
          timeoutMs: large ? 120000 : 60000,
          maxRetries: 0,
          maxTokens: Math.min(outputCap, model.maxTokens),
          reasoning: "off",
          toolChoice: "none",
          cacheRetention: "none",
          onPayload: (body, actual) => {
            if (summaryMode) body.response_format = { type: "json_object" };
            validate(body, actual);
          },
          fetch: async (url, options) => {
            const target = new URL(String(url));
            if (
              !allowed() ||
              dispatched ||
              target.origin !== "https://api.deepseek.com" ||
              target.username ||
              target.password ||
              target.hash ||
              target.search ||
              !["/chat/completions", "/v1/chat/completions"].includes(target.pathname) ||
              options?.method !== "POST"
            )
              throw new Error("Warm dispatch refused");
            const wire = typeof options.body === "string" ? JSON.parse(options.body) : null;
            validate(wire, model); // Re-check actual serialized JSON, not only the earlier callback.
            dispatched = true;
            stage = "transport";
            onEvent({
              phase: "dispatch",
              at: new Date().toISOString(),
              sourceHash: plan.sourceHash,
              wireHash: createHash("sha256").update(options.body).digest("hex"),
              model: "deepseek/deepseek-flash",
              origin: target.origin,
              thinking: "disabled",
            });
            const response = await transport(url, { ...options, redirect: "error" });
            status = response.status;
            stage = "response";
            onEvent({ phase: "response", at: new Date().toISOString(), status: response.status });
            return response;
          },
        },
      );
      stopReason = result.stopReason;
      output = result.usage?.output;
      if (
        !allowed() ||
        !dispatched ||
        result.stopReason !== "stop" ||
        result.content.some((part) => part.type !== "text") ||
        (result.usage?.reasoning ?? 0) > 0
      )
        throw new Error("Warm result refused");
      onEvent({
        phase: "completed",
        at: new Date().toISOString(),
        input: result.usage?.input,
        output: result.usage?.output,
        reasoning: result.usage?.reasoning,
        totalTokens: result.usage?.totalTokens,
      });
      return { answer: result.content.map((part) => part.text).join(""), usage: result.usage };
    } catch {
      onEvent({
        phase: signal?.aborted ? "cancelled" : "failed",
        at: new Date().toISOString(),
        stage,
        status,
        stopReason,
        output,
      });
      signal?.throwIfAborted();
      throw new Error(
        `Flash incremental warm failed (${stage}; HTTP ${status ?? "unknown"}; stop ${stopReason ?? "unknown"}; output ${output ?? "unknown"}); no retry, native-summary or provider fallback.`,
      );
    }
  };
}
