import { createHash } from "node:crypto";
import {
  convertToLlm,
  estimateTokens,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  estimateEnvelope,
  nativeBudgetHints,
  planWireBudget,
  wireText,
  TIERED_BUDGET,
  type BudgetPolicy,
  type BudgetReport,
} from "./tiered-budget.mjs";
import { tieredHash, buildTieredSnapshot, pendingNativeSource } from "./tiered-workspace.mjs";
import {
  WEB_CONTRACT,
  isTieredWebModel,
  buildTieredWebPlan,
  checkWebDispatch,
  checkWebReceipt,
} from "./tiered-web.mjs";
import { planCodexBudget, nativeBudgetView, checkCodexDispatch } from "./tiered-codex-budget.mjs";
import {
  buildWarmConsolidation,
  applyWarmConsolidation,
  buildWarmPlan,
  splitWarmPlan,
  mergeWarmAnswers,
  validateWarmAnswer,
  type WarmRecord,
} from "./tiered-warm.mjs";
import { listWarmModels, supportsWarmModel, type WarmRunnerFactory } from "./tiered-warm-remote.mjs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { contextSizePlan } from "./context-size.ts";

type SupportedModel = NonNullable<AgentSession["model"]>;
function refuse(reason: string): never {
  throw new Error(`TIERED_POLICY_REFUSED: ${reason}`);
}
const chatOutputLimit = (model: SupportedModel) =>
  model.api === "openai-codex-responses" || isTieredWebModel(model)
    ? Math.min(model.maxTokens, Math.max(1, Math.floor(model.contextWindow / 4)))
    : Math.min(model.maxTokens, 2048, Math.max(1, Math.floor(model.contextWindow / 4)));

export const supportsTieredModel = (model: SupportedModel) =>
  (model.api === "openai-completions" && ["openai", "deepseek"].includes(model.provider)) ||
  (model.api === "openai-codex-responses" && model.provider === "openai-codex") ||
  isTieredWebModel(model) ||
  !["opencli-page"].includes(model.api);

/** Experimental, session-only byte-BPE text policy. Native SDK remains the sole compressor. */
export class TieredBudgetController {
  private session?: AgentSession;
  private grant?: { manager: ExtensionContext["sessionManager"]; sessionId: string; ui: ExtensionContext["ui"] };
  private webAbort?: AbortController;
  lastWebReport?: ReturnType<typeof buildTieredWebPlan>["report"];
  private generation = 0;
  private compacting = false;
  private compactionPaused = false;
  private compactSource?: {
    grant: NonNullable<TieredBudgetController["grant"]>;
    generation: number;
    branchHash: string;
    fileHash: string;
    firstKeptEntryId: string;
  };
  private warmMode = true;
  private warmTarget = "deepseek/deepseek-flash";
  private warmCandidate?: { summaryHash: string; detailsHash: string; consentVersion: number };
  private readonly warmRunner?: WarmRunnerFactory;
  private readonly consentVersion: () => number;
  private installed = false;
  private readonly promptAdmission = new Map<symbol, boolean>();
  private readonly policy: BudgetPolicy;
  private readonly adaptive: boolean;
  private readonly automatic: boolean;
  private readonly supports: (model: SupportedModel) => boolean;
  lastReport?: BudgetReport;

  constructor({
    policy = TIERED_BUDGET,
    warmRunner,
    consentVersion = () => 0,
    supports = supportsTieredModel,
    adaptive = false,
    automatic = false,
  }: {
    policy?: BudgetPolicy;
    supports?: (model: SupportedModel) => boolean;
    adaptive?: boolean;
    automatic?: boolean;
    warmRunner?: WarmRunnerFactory;
    consentVersion?: () => number;
  } = {}) {
    this.policy = Object.freeze({ ...policy });
    this.adaptive = adaptive;
    this.automatic = automatic;
    this.supports = supports;
    this.warmRunner = warmRunner;
    this.consentVersion = consentVersion;
  }
  get enabled() {
    return Boolean(this.grant);
  }
  private policyFor(model: SupportedModel): BudgetPolicy {
    if (!this.adaptive) return this.policy;
    return {
      ...this.policy,
      hotMax: Math.max(this.policy.hotTarget, model.contextWindow - chatOutputLimit(model) - this.policy.safety),
    };
  }
  private supported(model: SupportedModel): boolean {
    const runtime = this.session?.modelRuntime;
    const custom = runtime?.getRegisteredProviderConfig(model.provider)?.streamSimple;
    if (isTieredWebModel(model))
      return Boolean(custom && "tieredWebContract" in custom && custom.tieredWebContract === WEB_CONTRACT);
    return (
      this.supports(model) &&
      !runtime?.getRegisteredProviderConfig(model.provider)?.streamSimple &&
      !runtime?.getRegisteredNativeProvider(model.provider)
    );
  }
  private disable() {
    this.generation++;
    this.webAbort?.abort();
    this.grant = undefined;
    this.warmMode = true;
    this.warmTarget = "deepseek/deepseek-flash";
    this.warmCandidate = undefined;
    this.compacting = false;
    this.compactSource = undefined;
    this.compactionPaused = false;
    this.session?.abortCompaction();
  }
  private sourceFingerprint(): string {
    const manager = this.session?.sessionManager;
    const path = manager?.getSessionFile();
    if (!manager || !path) refuse("native-source-not-flushed");
    const pending = pendingNativeSource(manager);
    if (pending) return tieredHash(pending);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) refuse("native-source-file-limit");
      const digest = createHash("sha256");
      const expected = manager.getEntries();
      let index = -1;
      let carry = "";
      const checkLine = (line: string) => {
        if (!line.trim()) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          refuse("native-source-invalid-jsonl");
        }
        if (
          index === -1 ? entry.id !== manager.getSessionId() : JSON.stringify(entry) !== JSON.stringify(expected[index])
        )
          refuse("native-source-not-consistent");
        index++;
      };
      const buffer = Buffer.alloc(64 * 1024);
      // JSONL is UTF-8; decoder preserves multibyte characters spanning chunks.
      const decoder = new TextDecoder();
      for (let length; (length = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
        const chunk = buffer.subarray(0, length);
        digest.update(chunk);
        carry += decoder.decode(chunk, { stream: true });
        const lines = carry.split("\n");
        carry = lines.pop()!;
        for (const line of lines) checkLine(line);
      }
      carry += decoder.decode();
      checkLine(carry);
      if (index !== expected.length || fstatSync(fd).mtimeMs !== stat.mtimeMs) refuse("native-source-not-consistent");
      return digest.digest("hex");
    } finally {
      closeSync(fd);
    }
  }
  /** Public settings reads only. No settings.json writes; proxy is unique to this session. */
  wrapSettings(native: SettingsManager): SettingsManager {
    return new Proxy(native, {
      get: (target, property) => {
        if (property === "getCacheWarmingMode") return () => (this.enabled ? "off" : target.getCacheWarmingMode());
        if (property === "getRetrySettings")
          return () => (this.enabled ? { ...target.getRetrySettings(), enabled: false } : target.getRetrySettings());
        if (property === "getProviderRetrySettings")
          return () =>
            this.enabled ? { ...target.getProviderRetrySettings(), maxRetries: 0 } : target.getProviderRetrySettings();
        if (property === "getCompactionSettings")
          return (model?: SupportedModel) => {
            const base = target.getCompactionSettings(model);
            if (!this.enabled || !this.session || !model) return base;
            if (!this.supported(model) || [...this.promptAdmission.values()].some((fits) => !fits))
              return { ...base, enabled: false };
            if (
              this.adaptive &&
              contextSizePlan(this.session.sessionManager.buildSessionProjection().messages, {
                ...model,
                maxTokens: chatOutputLimit(model),
              }).mode !== "warm"
            )
              return { ...base, enabled: false };
            const hints = nativeBudgetHints(
              this.session.sessionManager.buildSessionProjection().messages,
              { ...model, maxTokens: chatOutputLimit(model) },
              estimateTokens,
              this.policyFor(model),
            );
            return {
              ...base,
              enabled: !this.compactionPaused && hints.needsNativeCompaction,
              reserveTokens: hints.reserveTokens,
              keepRecentTokens: hints.keepRecentTokens,
            };
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  install(session: AgentSession) {
    if (this.installed) throw new Error("Budget controller already installed");
    this.installed = true;
    this.session = session;
    const originalPrompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
      if (!this.enabled || text.startsWith("/") || !session.model) return originalPrompt(text, options);
      const model = session.model;
      const messages = session.sessionManager.buildSessionProjection().messages;
      const protocolAndWarm = [
        { role: "system", content: getCurrentSystemPrompt(messages), toolsAdded: getCurrentTools(messages) },
        ...messages.filter((message) => message.role === "compactionSummary"),
      ];
      const standalone = estimateEnvelope(
        [...protocolAndWarm, { role: "user", content: text }],
        protocolAndWarm.length + 1,
      ).estimatedTokens;
      const ticket = Symbol("prompt-admission");
      this.promptAdmission.set(
        ticket,
        estimateEnvelope([{ role: "user", content: text }], 1).estimatedTokens <= this.policyFor(model).hotMax &&
          standalone + chatOutputLimit(model) + this.policy.safety <= model.contextWindow,
      );
      // Suppress pre-prompt summary requests for obviously non-fitting incoming input,
      // but let native SDK record the user message. Final stream guard refuses its dispatch.
      try {
        return await originalPrompt(text, options);
      } finally {
        this.promptAdmission.delete(ticket);
      }
    };
    const manager = session.sessionManager;
    const append = manager.appendCompaction.bind(manager);
    manager.appendCompaction = (summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) => {
      if (this.enabled) {
        const source = this.compactSource;
        if (
          !source ||
          source.grant !== this.grant ||
          source.generation !== this.generation ||
          source.branchHash !== tieredHash(JSON.stringify(manager.getBranch())) ||
          source.fileHash !== this.sourceFingerprint() ||
          firstKeptEntryId !== source.firstKeptEntryId
        )
          refuse("compaction-source-or-cut-invalidated");
        if (
          this.warmMode &&
          (!fromHook ||
            this.warmCandidate?.consentVersion !== this.consentVersion() ||
            this.warmCandidate?.summaryHash !== tieredHash(summary) ||
            this.warmCandidate.detailsHash !== tieredHash(JSON.stringify(details)))
        )
          refuse("unapproved-flash-candidate-or-native-fallback");
        const warm = convertToLlm([{ role: "compactionSummary", summary, tokensBefore, timestamp: 0 }]);
        if (!summary.trim() || estimateEnvelope(warm, warm.length).estimatedTokens > this.policy.warmMax)
          refuse("warm-candidate-not-committed");
      }
      return append(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage);
    };
    const original = session.agent.streamFunction;
    session.agent.streamFunction = async (model, context, options) => {
      const grant = this.grant;
      const providerOptions = {
        ...options,
        sessionId:
          (options as typeof options & { desktopModelSessionId?: string })?.desktopModelSessionId ?? options?.sessionId,
      };
      if (!grant) return original(model, context, providerOptions);
      const generation = this.generation;
      if (grant.sessionId !== session.sessionId) refuse("unsupported-or-replaced-session-model");
      if (!this.supported(model)) return original(model, context, providerOptions);
      this.sourceFingerprint();
      if (isTieredWebModel(model)) {
        if (this.compacting || options?.sessionId !== session.sessionId) refuse("web-auxiliary-operation");
        const snapshot = buildTieredSnapshot(session.sessionManager);
        if (
          tieredHash(JSON.stringify(context.messages.filter((message) => message.role !== "system"))) !==
          tieredHash(
            JSON.stringify(
              convertToLlm(session.sessionManager.buildSessionProjection().messages).filter(
                (message) => message.role !== "system",
              ),
            ),
          )
        )
          refuse("web-context-not-native-projection");
        let conversationId: string | undefined;
        for (const entry of session.sessionManager.getBranch()) {
          if (entry.type !== "custom") continue;
          const data = entry.data as { modelId?: string; remote?: { conversationId?: string } };
          if (data?.modelId !== model.id) continue;
          if (entry.customType === "page-provider-binding-reset") conversationId = undefined;
          else if (["page-provider-binding", "page-provider-binding-provisional"].includes(entry.customType))
            conversationId = data.remote?.conversationId;
        }
        const extra = options as typeof options & {
          pageImages?: Array<{ type: string; data: string; mimeType: string }>;
        };
        const plan = buildTieredWebPlan(snapshot, model, this.policyFor(model), {
          images: extra?.pageImages,
          conversationId,
          systemPrompt: getCurrentSystemPrompt(context.messages),
        });
        this.lastWebReport = plan.report;
        const initialEntries = structuredClone(session.sessionManager.getEntries());
        let dispatchId: string | undefined;
        let observedRemote: unknown;
        const valid = () => {
          const fingerprint = this.sourceFingerprint();
          if (fingerprint !== snapshot.identity.sourceHash) {
            // The driver's own body-free provisional binding is allowed AFTER dispatch.
            // No message, cut, foreign metadata or in-place edit can ride this exception.
            const entries = session.sessionManager.getEntries();
            const extra = entries.slice(initialEntries.length);
            const entry = extra[0];
            if (
              !dispatchId ||
              extra.length !== 1 ||
              entry?.type !== "custom" ||
              entry.customType !== "page-provider-binding-provisional" ||
              entry.parentId !== snapshot.identity.leafId ||
              tieredHash(JSON.stringify(entries.slice(0, initialEntries.length))) !==
                tieredHash(JSON.stringify(initialEntries))
            )
              refuse("web-native-source-changed");
            const data = entry.data as {
              sessionId?: string;
              modelId?: string;
              remote?: { site?: string; mode?: string };
            };
            if (
              data.sessionId !== session.sessionId ||
              data.modelId !== model.id ||
              data.remote?.site !== plan.payload.site ||
              data.remote.mode !== plan.payload.mode
            )
              refuse("web-foreign-binding");
            observedRemote = data.remote;
          }
          if (
            this.grant !== grant ||
            this.generation !== generation ||
            options?.signal?.aborted ||
            session.model?.id !== model.id ||
            session.model.provider !== model.provider ||
            plan.payload.projectionHash !==
              tieredHash(JSON.stringify(session.sessionManager.buildSessionProjection().messages))
          )
            refuse("web-permission-or-source-invalidated");
        };
        valid();
        const approved =
          this.automatic ||
          (await grant.ui.confirm(
            "Approve this ONE complete Web context?",
            `Target: ${model.provider}/${model.id}; site ${plan.payload.site}; mode ${plan.payload.mode}.\nFresh remote conversation for this full context; old website conversations are NOT deleted. No retry/fallback. Website window/output/usage are unmeasured; catalog estimates do not enforce a browser output cap.\nNative source ${plan.payload.sourceHash}; warm ${plan.warmVersion ?? "none"}; ${plan.hotSourceEntryIds.length} complete visible hot messages. ${plan.omittedThinking} reasoning blocks/signatures remain local. System/tool declarations, cold and human agents.md remain local. No redaction of visible task/tool evidence; approve only if this whole text may leave for this website. Flash/workspace/budget permissions do NOT approve this dispatch.\nFULL FINAL TEXT (not truncated):\n${plan.payload.text}`,
          ));
        if (!approved) refuse("web-source-not-approved");
        valid();
        const controller = new AbortController();
        this.webAbort = controller;
        const signal = controller.signal;
        // Electron's embedded Node can lack AbortSignal.any; retain fail-closed cancellation there.
        const inheritAbort = () => controller.abort();
        options?.signal?.addEventListener("abort", inheritAbort, { once: true });
        signal.addEventListener("abort", () => options?.signal?.removeEventListener("abort", inheritAbort), {
          once: true,
        });
        if (options?.signal?.aborted) inheritAbort();
        let payloadChecked = false;
        let receiptChecked = false;
        return original(model, context, {
          ...options,
          signal,
          ...{
            pageProjection: plan.payload,
            pageBeforeDispatch: (request: unknown) => {
              valid();
              if (!payloadChecked || dispatchId || signal.aborted) refuse("web-duplicate-or-unapproved-dispatch");
              dispatchId = checkWebDispatch(request, plan.payload);
            },
            pageOnReceipt: (receipt: unknown, markdown: string) => {
              valid();
              if (!dispatchId || receiptChecked || signal.aborted) refuse("web-late-or-duplicate-receipt");
              checkWebReceipt(receipt, plan.payload, dispatchId, markdown);
              if (
                observedRemote &&
                JSON.stringify(observedRemote) !== JSON.stringify((receipt as { remote: unknown }).remote)
              )
                refuse("web-discovered-remote-changed");
              receiptChecked = true;
            },
          },
          onPayload: async (payload, actualModel) => {
            if (payloadChecked) refuse("web-duplicate-payload");
            const transformed = await options?.onPayload?.(payload, actualModel);
            valid();
            const finalPayload = JSON.parse(JSON.stringify(transformed ?? payload));
            if (
              actualModel.id !== model.id ||
              actualModel.provider !== model.provider ||
              JSON.stringify(finalPayload) !== JSON.stringify(plan.payload)
            )
              refuse("web-final-payload-mutated");
            payloadChecked = true;
            return finalPayload;
          },
        });
      }
      const projectionHash = tieredHash(JSON.stringify(session.sessionManager.buildSessionProjection().messages));
      let approvedCodexPayload: string | undefined;
      let codexDispatched = false;
      const operation = this.compacting ? "native-compaction" : "chat";
      if (operation === "native-compaction" && this.warmMode) refuse("native-summary-fallback-prohibited");
      if (operation === "chat" && options?.sessionId !== session.sessionId) refuse("auxiliary-operation-not-supported");
      const outputReserved =
        model.api === "openai-codex-responses"
          ? chatOutputLimit(model)
          : operation === "chat"
            ? chatOutputLimit(model)
            : Math.min(model.maxTokens, this.policy.warmTarget);
      const budgetView = nativeBudgetView(context.messages);
      if (
        estimateEnvelope({ ...context, messages: budgetView.messages }, context.messages.length).estimatedTokens +
          budgetView.opaqueReserved +
          outputReserved +
          this.policy.safety >
        model.contextWindow
      )
        refuse("preflight-envelope-reservation");
      const warmMessage = session.sessionManager
        .buildSessionProjection()
        .messages.find((message) => message.role === "compactionSummary");
      const warmText = warmMessage ? wireText(convertToLlm([warmMessage])[0]) : undefined;
      return original(model, context, {
        ...options,
        sessionId:
          (options as typeof options & { desktopModelSessionId?: string })?.desktopModelSessionId ?? options?.sessionId,
        // Native summary stays on its selected model, never an implicit Flash/fallback request.
        maxTokens: outputReserved,
        ...(model.api === "openai-codex-responses"
          ? {
              transport: "sse" as const,
              maxRetries: 0,
              fetch: async (url: string | URL | Request, init?: RequestInit) => {
                if (
                  codexDispatched ||
                  init?.method !== "POST" ||
                  this.grant !== grant ||
                  this.generation !== generation ||
                  options?.signal?.aborted
                )
                  refuse("codex-dispatch-invalidated");
                this.sourceFingerprint();
                checkCodexDispatch(url, init?.body, model, approvedCodexPayload);
                codexDispatched = true;
                return (options?.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error" });
              },
            }
          : {}),
        onPayload: async (payload, actualModel) => {
          const transformed = await options?.onPayload?.(payload, actualModel);
          this.sourceFingerprint();
          if (projectionHash !== tieredHash(JSON.stringify(session.sessionManager.buildSessionProjection().messages)))
            refuse("projected-source-invalidated");
          if (this.grant !== grant || this.generation !== generation || options?.signal?.aborted)
            refuse("permission-or-source-invalidated");
          if (actualModel.provider !== model.provider || actualModel.id !== model.id || actualModel.api !== model.api)
            refuse("request-model-changed");
          // Detach accessors/toJSON/live references before validation and provider serialization.
          const finalPayload = JSON.parse(JSON.stringify(transformed ?? payload)) as Record<string, unknown>;
          const output = finalPayload.max_tokens ?? finalPayload.max_completion_tokens;
          if (model.api === "openai-completions" && (typeof output !== "number" || output > outputReserved))
            refuse("output-reservation-mutated");
          if (!["openai-completions", "openai-codex-responses"].includes(model.api)) return finalPayload;
          // No throwing extension hook here: this callback is the SDK provider's final pre-fetch callback.
          const report =
            model.api === "openai-codex-responses"
              ? planCodexBudget(finalPayload, actualModel, {
                  nativeMessages: context.messages,
                  warmText,
                  operation,
                  policy: this.policyFor(model),
                  outputReservation: outputReserved,
                })
              : planWireBudget(finalPayload, actualModel, { warmText, operation, policy: this.policyFor(model) });
          this.lastReport = report; // Numeric/algorithm metadata only, no history/payload/headers.
          if (report.action !== "allow") refuse(report.reasons.join(","));
          if (model.api === "openai-codex-responses") approvedCodexPayload = JSON.stringify(finalPayload);
          return finalPayload;
        },
      });
    };
  }
  extension() {
    return {
      name: "pi-desktop-tiered-budget-compare",
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" = "info") => {
          try {
            ctx.ui.notify(text, type);
          } catch {
            /* Invalidated UI must not reopen permission. */
          }
        };
        pi.registerCommand("tiered-budget-enable", {
          description: "Compare: session-only conservative text budget and native compaction coordinator",
          handler: async (_args, ctx) => {
            if (this.enabled) {
              notify(ctx, "Session budget policy already enabled.");
              return;
            }
            const session = this.session;
            if (!session || !ctx.hasUI || !ctx.isIdle() || !ctx.model || !this.supported(ctx.model)) {
              notify(
                ctx,
                "Requires idle/UI approval and supported Completions/Codex or updated tier-contract Web provider; no fallback.",
                "warning",
              );
              return;
            }
            try {
              this.sourceFingerprint();
            } catch {
              notify(
                ctx,
                "Requires flushed and consistent native history; finish an ordinary turn first or resolve source conflict.",
                "warning",
              );
              return;
            }
            const manager = ctx.sessionManager;
            const sessionId = manager.getSessionId();
            const leaf = manager.getLeafId();
            const generation = this.generation;
            const accepted = await ctx.ui.confirm(
              "Enable experimental session budget?",
              [
                "No request is sent by enabling. API requests retain native system/tools + one native warm summary + full hot messages. Updated Web targets separately review/export one warm + all visible hot into a fresh conversation; system/tools/cold/reasoning remain local.",
                this.adaptive
                  ? "Adaptive routing: small native history up to approximately 4000 tokens; medium complete hot context up to approximately 16000; only larger history or 85% of conservative target capacity triggers warm. Thresholds shrink to 10%/35% of available target capacity. No extra summary request for small/medium history. SDK estimates are NOT exact token counts; final serialized capacity checks still apply."
                  : `Text-only conservative ESTIMATE, not exact token counting: hot target ${this.policy.hotTarget}/max ${this.policy.hotMax}; warm target ${this.policy.warmTarget}/max ${this.policy.warmMax}.`,
                "Byte-BPE JSON envelope/framing may refuse much earlier than a tokenizer; provider framing is not officially calibrated. Images/unmeasured opaque thinking/other APIs are unsupported. Codex replay reserves provider-reported output+reasoning per opaque item, never base64 bytes as tokens; this is an assumption, not a certified tokenizer.",
                "SDK remains the only compaction owner. Default warm processor is DeepSeek Flash; /tiered-warm-model lists or selects a configured API/local Ollama processor for this session. It is NOT the main chat model. This budget approval does NOT authorize sending source: each warm delta requires source approval and final candidate review. Missing processor/cancel/failure never falls back to another model. /tiered-warm-native is an explicit session-only alternative; navigation/restart resets the selection without restoring any permission.",
                "System/tool schemas and safety reduce API history; Completions output is capped at min(model maximum, 2048, quarter window). Codex reserves the FULL catalog maximum without an enforced cap, uses SSE and no WebSocket fallback/retries. Web website window/output cap/usage are unmeasured: catalog reservation is only a hint, zero SDK usage is a placeholder. Complete visible Web text must fit estimates and transport bounds; no silent cut or legacy handoff fallback.",
                "Failed/cancelled warm generation pauses automatic compaction until explicit manual /compact or re-approval. For this session only: suppress cache warming and automatic retries. No settings-file writes, source deletion, Web/remote fallback or extra handoff prompt.",
                "Navigation/replacement/restart revokes this experimental policy. Local workspace export has a separate approval.",
              ].join("\n"),
            );
            if (
              !accepted ||
              generation !== this.generation ||
              session !== this.session ||
              manager !== ctx.sessionManager ||
              sessionId !== manager.getSessionId() ||
              leaf !== manager.getLeafId() ||
              !ctx.isIdle()
            )
              return;
            this.grant = { manager, sessionId, ui: ctx.ui };
            this.compactionPaused = false;
            notify(ctx, "Experimental native budget coordinator enabled; estimates are not exact tokens.");
          },
        });
        pi.registerCommand("tiered-budget-disable", {
          description: "Restore native session budgeting without rewriting settings/history",
          handler: async (_args, ctx) => {
            this.disable();
            notify(ctx, "Experimental budget disabled; original settings reads restored.");
          },
        });
        pi.registerCommand("tiered-budget-status", {
          description: "Show last numeric budget report; no request or history export",
          handler: async (_args, ctx) => {
            notify(
              ctx,
              JSON.stringify({
                enabled: this.enabled,
                contextSize:
                  this.adaptive && this.session?.model
                    ? contextSizePlan(this.session.sessionManager.buildSessionProjection().messages, {
                        ...this.session.model,
                        maxTokens: chatOutputLimit(this.session.model),
                      })
                    : null,
                compactionPaused: this.compactionPaused,
                warmProcessor: this.warmMode ? "model-per-attempt-review" : "native",
                warmTarget: this.warmMode ? this.warmTarget : null,
                lastReport: this.lastReport ?? null,
                lastWebReport: this.lastWebReport ?? null,
              }),
            );
          },
        });
        pi.registerCommand("tiered-warm-model", {
          description:
            "List or select an available API/local Ollama warm processor: /tiered-warm-model [provider/model]",
          handler: async (args, ctx) => {
            if (!this.enabled || !this.warmRunner || !ctx.hasUI || !ctx.isIdle() || !this.session) {
              notify(ctx, "Requires approved budget, idle UI and a warm processor; nothing sent.", "warning");
              return;
            }
            const runtime = this.session.modelRuntime;
            const grant = this.grant;
            const generation = this.generation;
            const candidates = await listWarmModels(runtime);
            if (!grant || grant !== this.grant || generation !== this.generation || !ctx.isIdle()) return;
            const selected = args.trim();
            if (!selected || selected === "list") {
              notify(ctx, JSON.stringify({ selected: this.warmMode ? this.warmTarget : null, candidates }));
              return;
            }
            const divider = selected.indexOf("/");
            const model =
              divider > 0 && divider < selected.length - 1
                ? runtime.getModel(selected.slice(0, divider), selected.slice(divider + 1))
                : undefined;
            if (!model || !candidates.includes(selected) || !supportsWarmModel(model, runtime)) {
              notify(ctx, "Warm model is not available or its endpoint/API is unsupported; nothing sent.", "warning");
              return;
            }
            this.generation++;
            this.warmCandidate = undefined;
            this.warmMode = true;
            this.warmTarget = selected;
            notify(
              ctx,
              `Warm processor selected: ${selected}. This does not authorize any source; every attempt still requires review.`,
            );
          },
        });
        pi.registerCommand("tiered-warm-flash", {
          description: "Select incremental Flash warm; each source and result require separate review",
          handler: async (_args, ctx) => {
            if (!this.enabled || !this.warmRunner || !ctx.hasUI || !ctx.isIdle()) {
              notify(ctx, "Requires approved budget, idle UI and Flash processor; nothing sent.", "warning");
              return;
            }
            this.warmMode = true;
            this.warmTarget = "deepseek/deepseek-flash";
            this.generation++;
            notify(
              ctx,
              "DeepSeek Flash warm selected, NOT authorized. Each native prepared delta needs full source approval and final evidence review; cancel/failure never falls back to native summary. Existing task-memory/website grants are not reused.",
            );
          },
        });
        pi.registerCommand("tiered-warm-native", {
          description: "Explicitly restore native selected-model summaries, not automatic fallback",
          handler: async (_args, ctx) => {
            this.generation++;
            this.session?.abortCompaction();
            this.warmMode = false;
            this.warmCandidate = undefined;
            notify(
              ctx,
              "Native warm explicitly selected. Automatic compaction pause remains until manual /compact or budget re-approval.",
            );
          },
        });
        pi.on("session_before_compact", async (event, ctx) => {
          if (!this.enabled) return;
          if (this.compactionPaused && event.reason !== "manual") return { cancel: true };
          if (event.reason === "manual") this.compactionPaused = false;
          const branch = event.branchEntries;
          const projection = ctx.sessionManager.buildSessionProjection();
          const latestUser = [...projection.entries]
            .reverse()
            .find(({ messages }) => messages.some((message) => message.role === "user"));
          const protectedIndex = latestUser ? branch.findIndex((entry) => entry.id === latestUser.sourceEntry.id) : 0;
          const keptIndex = branch.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
          if (keptIndex < 0 || keptIndex > protectedIndex) {
            notify(
              ctx,
              "Native compaction refused: would split/remove the latest user span. Hot source retained; reduce the request/tool output or wait for supported incremental warm processing.",
              "warning",
            );
            return { cancel: true };
          }
          try {
            this.compactSource = {
              grant: this.grant!,
              generation: this.generation,
              branchHash: tieredHash(JSON.stringify(branch)),
              fileHash: this.sourceFingerprint(),
              firstKeptEntryId: event.preparation.firstKeptEntryId,
            };
            this.compacting = true;
            this.warmCandidate = undefined;
            if (this.warmMode) {
              if (!ctx.hasUI || !this.warmRunner) throw new Error("Flash source UI/processor unavailable");
              const source = this.compactSource;
              const consentVersion = this.consentVersion();
              const authorized = () => {
                try {
                  return (
                    consentVersion === this.consentVersion() &&
                    !event.signal.aborted &&
                    this.warmMode &&
                    source === this.compactSource &&
                    source.grant === this.grant &&
                    source.generation === this.generation &&
                    source.branchHash === tieredHash(JSON.stringify(this.session!.sessionManager.getBranch())) &&
                    source.fileHash === this.sourceFingerprint()
                  );
                } catch {
                  return false;
                }
              };
              const plan = buildWarmPlan(ctx.sessionManager, event.preparation);
              const warmTarget = this.warmTarget;
              const warmModel = this.session!.modelRuntime.getModel(
                warmTarget.slice(0, warmTarget.indexOf("/")),
                warmTarget.slice(warmTarget.indexOf("/") + 1),
              );
              if (!supportsWarmModel(warmModel, this.session!.modelRuntime)) throw new Error("Warm target unavailable");
              const warmDestination = warmModel!.baseUrl;
              const segments = splitWarmPlan(plan);
              const answers: string[] = [];
              let warmUsage;
              for (const segment of segments) {
                const approved = await ctx.ui.confirm(
                  "Approve this ONE incremental Flash payload?",
                  `Segment ${segment.segment?.index ?? 1}/${segments.length}; at most 64 KiB per request. Only this incremental source is sent. Native context advances only after all segments pass final review.\nTarget: ${warmTarget} @ ${warmDestination} (endpoint and serialized request verified before dispatch)\nMode: ${plan.schema}. The processor paraphrases useful decisions, results and pending work, and drops chatter/repetition. No exhaustive record or number coverage is required. All source stays in native cold history.\nOutput cap ≤4096 for long source, ≤2048 otherwise; thinking disabled; no tools/retries/redirects/cache writes. Network/proxy routing is controlled by Desktop/OS; an Ollama endpoint must be on this Mac's loopback, not another LAN host.\nNo automatic redaction. Includes quoted user/assistant and completed tool data; excludes system/protocol, cold and previous warm. Reasoning/signatures are NOT sent: only visible task text/tool evidence is organized; reasoning stays in native cold history and leaves active replay after approved compaction. No tools executed by the processor. Source permission expires with this attempt.\nSYSTEM:\n${segment.instructions}\nUSER:\n${segment.payload}`,
                );
                if (!approved || !authorized()) return { cancel: true };
                const reply = await this.warmRunner({ signal: event.signal, authorized, target: warmTarget })(segment);
                if (!authorized()) return { cancel: true };
                validateWarmAnswer(segment, reply.answer);
                answers.push(reply.answer);
                if (reply.usage) {
                  if (!warmUsage) warmUsage = structuredClone(reply.usage);
                  else {
                    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
                      warmUsage[key] += reply.usage[key];
                    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
                      warmUsage.cost[key] += reply.usage.cost[key];
                  }
                }
              }
              let candidate = mergeWarmAnswers(plan, segments, answers);
              const candidateSize = () => {
                const messages = convertToLlm([
                  {
                    role: "compactionSummary",
                    summary: candidate.summary,
                    tokensBefore: candidate.tokensBefore,
                    timestamp: 0,
                  },
                ]);
                return estimateEnvelope(messages, messages.length).estimatedTokens;
              };
              if (candidateSize() > this.policy.warmMax) {
                const consolidation = buildWarmConsolidation(plan, candidate);
                const approved = await ctx.ui.confirm(
                  "合并增量摘要",
                  `摘要需要进一步去重才能放入 warm。此次仅发送下方已有摘要，不重新读取完整 JSONL。\n${consolidation.payload}`,
                );
                if (!approved || !authorized()) return { cancel: true };
                const reply = await this.warmRunner({ signal: event.signal, authorized, target: warmTarget })(
                  consolidation,
                );
                if (!authorized()) return { cancel: true };
                candidate = applyWarmConsolidation(plan, candidate, consolidation, reply.answer);
                if (reply.usage) {
                  if (!warmUsage) warmUsage = structuredClone(reply.usage);
                  else {
                    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
                      warmUsage[key] += reply.usage[key];
                    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
                      warmUsage.cost[key] += reply.usage.cost[key];
                  }
                }
              }
              const warm = convertToLlm([
                {
                  role: "compactionSummary",
                  summary: candidate.summary,
                  tokensBefore: candidate.tokensBefore,
                  timestamp: 0,
                },
              ]);
              if (estimateEnvelope(warm, warm.length).estimatedTokens > this.policy.warmMax) return { cancel: true };
              const reviewed = await ctx.ui.confirm(
                "Review warm summary before context update",
                `The selected warm processor may paraphrase and omit irrelevant or repeated content. Check that useful decisions, results and pending work are correct. Structural validation does not establish semantic accuracy. Original JSONL is retained.\nCANDIDATE:\n${candidate.summary}\nSOURCE:\n${plan.payload}`,
              );
              if (!reviewed || !authorized()) return { cancel: true };
              (candidate.details as { tieredWarm: WarmRecord }).tieredWarm.review = "human-approved-not-proven";
              this.warmCandidate = {
                consentVersion,
                summaryHash: tieredHash(candidate.summary),
                detailsHash: tieredHash(JSON.stringify(candidate.details)),
              };
              return { compaction: { ...candidate, usage: warmUsage } };
            }
          } catch {
            notify(
              ctx,
              "Warm preparation/source/processor/quality refused; no native fallback, no promotion, original hot retained. A processor request may already have been dispatched.",
              "warning",
            );
            return { cancel: true };
          }
        });
        pi.on("session_compact", () => {
          this.compacting = false;
          this.compactSource = undefined;
          this.compactionPaused = false;
          this.warmCandidate = undefined;
        });
        pi.on("session_compact_failed", (_event, ctx) => {
          this.compacting = false;
          this.compactSource = undefined;
          this.warmCandidate = undefined;
          if (this.enabled) {
            this.compactionPaused = true;
            notify(
              ctx,
              "Native warm update failed/cancelled. Automatic compaction paused; original hot retained. Retry requires explicit manual /compact or re-approval, never automatic fallback.",
              "warning",
            );
          }
        });
        pi.on("model_select", async (_event, ctx) => {
          this.generation++;
          this.webAbort?.abort();
          if (this.enabled) this.session?.abortCompaction();
          if (
            this.automatic &&
            this.enabled &&
            this.session?.model &&
            ctx.isIdle() &&
            contextSizePlan(this.session.sessionManager.buildSessionProjection().messages, {
              ...this.session.model,
              maxTokens: chatOutputLimit(this.session.model),
            }).mode === "warm"
          ) {
            try {
              await this.session.compact();
            } catch {
              notify(ctx, "Model handoff summary failed; original context retained. Retry with /compact.", "warning");
            }
          }
        });
        pi.on("session_start", (_event, ctx) => {
          this.disable();
          if (this.automatic)
            this.grant = { manager: ctx.sessionManager, sessionId: ctx.sessionManager.getSessionId(), ui: ctx.ui };
        });
        pi.on("session_before_switch", () => this.disable());
        pi.on("session_before_tree", () => this.disable());
        pi.on("session_before_fork", () => this.disable());
        pi.on("session_shutdown", () => this.disable());
      },
    };
  }
}
