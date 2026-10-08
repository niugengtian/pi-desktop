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
const DEFAULT_TARGET = "deepseek/deepseek-flash";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function endpoint(model) {
  try {
    const url = new URL(model.baseUrl);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "http:") {
      if (!LOOPBACK.has(url.hostname)) return null;
    } else if (url.protocol !== "https:") return null;
    const base = url.pathname.replace(/\/$/, "");
    if (base.includes("//") || base.endsWith("/chat/completions") || base.includes("%")) return null;
    return { origin: url.origin, pathname: `${base === "/" ? "" : base}/chat/completions` };
  } catch {
    return null;
  }
}

/** Only configured OpenAI-compatible HTTPS API or loopback model endpoints. */
export function supportsWarmModel(model, runtime) {
  if (
    !model ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string" ||
    model.provider === "opencli-page" ||
    model.api !== "openai-completions" ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 8192 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0 ||
    (model.samplingParams && Object.keys(model.samplingParams).length > 0) ||
    !endpoint(model)
  )
    return false;
  if (
    runtime?.getRegisteredProviderConfig?.(model.provider)?.streamSimple ||
    runtime?.getRegisteredNativeProvider?.(model.provider)
  )
    return false;
  return true;
}

export async function listWarmModels(runtime) {
  const providers = new Set(
    runtime
      .getModels()
      .filter((model) => supportsWarmModel(model, runtime))
      .map((model) => model.provider),
  );
  const available = await Promise.all(
    [...providers].map(async (provider) => {
      try {
        return await runtime.getAvailable(provider);
      } catch {
        return [];
      }
    }),
  );
  return [
    ...new Set(
      available
        .flat()
        .filter((model) => supportsWarmModel(model, runtime))
        .map((model) => `${model.provider}/${model.id}`),
    ),
  ].sort();
}

/** Transport injection exists for isolated tests, never a fallback or selectable endpoint. */
export function createFlashWarmRunner({
  runtime,
  signal,
  authorized,
  target = DEFAULT_TARGET,
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
    const validate = (body, actual) => {
      if (
        !body ||
        !allowed() ||
        !supportsWarmModel(actual, runtime) ||
        actual.provider !== model.provider ||
        actual.id !== model.id ||
        actual.baseUrl !== model.baseUrl ||
        body?.model !== model.id ||
        (body.thinking?.type !== "disabled" && body.thinking !== undefined) ||
        (body.enable_thinking !== false && body.enable_thinking !== undefined) ||
        (body.reasoning_effort !== undefined && body.reasoning_effort !== "none") ||
        body.reasoning?.enabled === true ||
        (body.reasoning?.effort && body.reasoning.effort !== "none") ||
        (body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking !== false) ||
        (body.chat_template_args && body.chat_template_args.enable_thinking !== false) ||
        body.thinking_token_budget !== undefined ||
        body.reasoning_budget !== undefined ||
        body.reasoning_tokens !== undefined ||
        body.generation?.thinking === true ||
        body.include_reasoning === true ||
        body.tools ||
        body.functions ||
        (body.tool_choice && body.tool_choice !== "none") ||
        (body.store !== undefined && body.store !== false) ||
        body.prompt_cache_key ||
        body.prompt_cache_retention ||
        body.stream !== true ||
        (summaryMode && body.response_format?.type !== "json_object") ||
        !Number.isSafeInteger(body.max_tokens ?? body.max_completion_tokens) ||
        (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) ||
        (body.max_tokens ?? body.max_completion_tokens) <= 0 ||
        (body.max_tokens ?? body.max_completion_tokens) > outputCap ||
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
      const divider = target.indexOf("/");
      if (divider <= 0 || divider === target.length - 1) throw new Error("Warm target refused");
      model = runtime.getModel(target.slice(0, divider), target.slice(divider + 1));
      const destination = model && endpoint(model);
      if (
        !allowed() ||
        !supportsWarmModel(model, runtime) ||
        !destination ||
        !plan.payload ||
        Buffer.byteLength(plan.payload) > (large ? WARM_SEGMENT_BYTES : 12000)
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
            // The SDK may apply credential-specific routing overrides. Compare the actual
            // request model and origin with the approved catalog model before dispatch.
            if (actual.baseUrl !== model.baseUrl) throw new Error("Warm endpoint changed");
            if (summaryMode) body.response_format = { type: "json_object" };
            validate(body, actual);
          },
          fetch: async (url, options) => {
            let actual;
            try {
              actual = new URL(String(url));
            } catch {
              throw new Error("Warm dispatch refused");
            }
            if (
              !allowed() ||
              dispatched ||
              actual.origin !== destination.origin ||
              actual.pathname !== destination.pathname ||
              actual.username ||
              actual.password ||
              actual.hash ||
              actual.search ||
              options?.method !== "POST"
            )
              throw new Error("Warm dispatch refused");
            const wire = typeof options.body === "string" ? JSON.parse(options.body) : null;
            validate(wire, model);
            dispatched = true;
            stage = "transport";
            onEvent({
              phase: "dispatch",
              at: new Date().toISOString(),
              sourceHash: plan.sourceHash,
              wireHash: createHash("sha256").update(options.body).digest("hex"),
              model: target,
              origin: actual.origin,
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
        `Warm incremental processing failed (${stage}; HTTP ${status ?? "unknown"}; stop ${stopReason ?? "unknown"}; output ${output ?? "unknown"}); no retry, native-summary or provider fallback.`,
      );
    }
  };
}
