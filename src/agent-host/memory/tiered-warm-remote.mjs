import { WARM_INSTRUCTIONS } from "./tiered-warm.mjs";
import { planWireBudget } from "./tiered-budget.mjs";
export const WARM_TARGET = "deepseek/deepseek-flash @ https://api.deepseek.com (thinking disabled)";
/** Transport injection exists for isolated tests, never a fallback or selectable endpoint. */
export function createFlashWarmRunner({ runtime, signal, authorized, transport = globalThis.fetch }) {
  return async (plan) => {
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
        !Number.isSafeInteger(body.max_tokens) ||
        body.max_tokens <= 0 ||
        body.max_tokens > 2048 ||
        body.messages?.length !== 2 ||
        body.messages[0].role !== "system" ||
        body.messages[0].content !== WARM_INSTRUCTIONS ||
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
        plan.payload.length > 12000 ||
        runtime.getRegisteredProviderConfig?.("deepseek")?.streamSimple ||
        runtime.getRegisteredNativeProvider?.("deepseek")
      )
        throw new Error("Warm target refused");
      const result = await runtime.completeSimple(
        model,
        {
          messages: [
            { role: "system", content: WARM_INSTRUCTIONS, timestamp: 0 },
            { role: "user", content: plan.payload, timestamp: 0 },
          ],
        },
        {
          signal,
          timeoutMs: 60000,
          maxRetries: 0,
          maxTokens: Math.min(2048, model.maxTokens),
          reasoning: "off",
          toolChoice: "none",
          cacheRetention: "none",
          onPayload: validate,
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
            return transport(url, { ...options, redirect: "error" });
          },
        },
      );
      if (
        !allowed() ||
        !dispatched ||
        result.stopReason !== "stop" ||
        result.content.some((part) => part.type !== "text") ||
        (result.usage?.reasoning ?? 0) > 0
      )
        throw new Error("Warm result refused");
      return { answer: result.content.map((part) => part.text).join(""), usage: result.usage };
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        "Flash incremental warm failed or consent changed; no retry, native-summary or provider fallback.",
      );
    }
  };
}
