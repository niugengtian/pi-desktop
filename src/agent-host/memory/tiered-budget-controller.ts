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
import { tieredHash } from "./tiered-workspace.mjs";
import { planCodexBudget, nativeBudgetView, checkCodexDispatch } from "./tiered-codex-budget.mjs";
import { buildWarmPlan, validateWarmAnswer, WARM_INSTRUCTIONS, type WarmRecord } from "./tiered-warm.mjs";
import { WARM_TARGET, type WarmRunnerFactory } from "./tiered-warm-remote.mjs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";

type SupportedModel = NonNullable<AgentSession["model"]>;
function refuse(reason: string): never {
  throw new Error(`TIERED_POLICY_REFUSED: ${reason}`);
}
const chatOutputLimit = (model: SupportedModel) =>
  model.api === "openai-codex-responses"
    ? model.maxTokens
    : Math.min(model.maxTokens, 2048, Math.max(1, Math.floor(model.contextWindow / 4)));

export const supportsTieredModel = (model: SupportedModel) =>
  (model.api === "openai-completions" && ["openai", "deepseek"].includes(model.provider)) ||
  (model.api === "openai-codex-responses" && model.provider === "openai-codex");

/** Experimental, session-only byte-BPE text policy. Native SDK remains the sole compressor. */
export class TieredBudgetController {
  private session?: AgentSession;
  private grant?: { manager: ExtensionContext["sessionManager"]; sessionId: string };
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
  private warmMode = false;
  private warmCandidate?: { summaryHash: string; detailsHash: string; consentVersion: number };
  private readonly warmRunner?: WarmRunnerFactory;
  private readonly consentVersion: () => number;
  private installed = false;
  private readonly promptAdmission = new Map<symbol, boolean>();
  private readonly policy: BudgetPolicy;
  private readonly supports: (model: SupportedModel) => boolean;
  lastReport?: BudgetReport;

  constructor({
    policy = TIERED_BUDGET,
    warmRunner,
    consentVersion = () => 0,
    supports = supportsTieredModel,
  }: {
    policy?: BudgetPolicy;
    supports?: (model: SupportedModel) => boolean;
    warmRunner?: WarmRunnerFactory;
    consentVersion?: () => number;
  } = {}) {
    this.policy = Object.freeze({ ...policy });
    this.supports = supports;
    this.warmRunner = warmRunner;
    this.consentVersion = consentVersion;
  }
  get enabled() {
    return Boolean(this.grant);
  }
  private supported(model: SupportedModel): boolean {
    const runtime = this.session?.modelRuntime;
    return (
      this.supports(model) &&
      !runtime?.getRegisteredProviderConfig(model.provider)?.streamSimple &&
      !runtime?.getRegisteredNativeProvider(model.provider)
    );
  }
  private disable() {
    this.generation++;
    this.grant = undefined;
    this.warmMode = false;
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
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) refuse("native-source-file-limit");
      const bytes = readFileSync(fd);
      let entries: unknown[];
      try {
        entries = bytes
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        refuse("native-source-invalid-jsonl");
      }
      if (
        (entries[0] as { id?: string })?.id !== manager.getSessionId() ||
        JSON.stringify(entries.slice(1)) !== JSON.stringify(manager.getEntries())
      )
        refuse("native-source-not-consistent");
      return tieredHash(bytes);
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
            const hints = nativeBudgetHints(
              this.session.sessionManager.buildSessionProjection().messages,
              { ...model, maxTokens: chatOutputLimit(model) },
              estimateTokens,
              this.policy,
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
        !options?.images?.length &&
          estimateEnvelope([{ role: "user", content: text }], 1).estimatedTokens <= this.policy.hotMax &&
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
      if (!grant) return original(model, context, options);
      const generation = this.generation;
      if (grant.sessionId !== session.sessionId || !this.supported(model))
        refuse("unsupported-or-replaced-session-model");
      this.sourceFingerprint();
      const projectionHash = tieredHash(JSON.stringify(session.sessionManager.buildSessionProjection().messages));
      let approvedCodexPayload: string | undefined;
      let codexDispatched = false;
      const operation = this.compacting ? "native-compaction" : "chat";
      if (operation === "native-compaction" && this.warmMode) refuse("native-summary-fallback-prohibited");
      if (operation === "chat" && options?.sessionId !== session.sessionId) refuse("auxiliary-operation-not-supported");
      const outputReserved =
        model.api === "openai-codex-responses"
          ? model.maxTokens
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
          if (model.api !== "openai-codex-responses" && (typeof output !== "number" || output > outputReserved))
            refuse("output-reservation-mutated");
          // No throwing extension hook here: this callback is the SDK provider's final pre-fetch callback.
          const report =
            model.api === "openai-codex-responses"
              ? planCodexBudget(finalPayload, actualModel, {
                  nativeMessages: context.messages,
                  warmText,
                  operation,
                  policy: this.policy,
                })
              : planWireBudget(finalPayload, actualModel, { warmText, operation, policy: this.policy });
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
                "Requires idle/UI approval and supported OpenAI-completions or Codex-Responses text model; no fallback.",
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
                "No request is sent by enabling. Next ordinary requests retain native system/tools + one native warm summary + full hot messages.",
                `Text-only conservative ESTIMATE, not exact token counting: hot target ${this.policy.hotTarget}/max ${this.policy.hotMax}; warm target ${this.policy.warmTarget}/max ${this.policy.warmMax}.`,
                "Byte-BPE JSON envelope/framing may refuse much earlier than a tokenizer; provider framing is not officially calibrated. Images/unmeasured opaque thinking/other APIs are unsupported. Codex replay reserves provider-reported output+reasoning per opaque item, never base64 bytes as tokens; this is an assumption, not a certified tokenizer.",
                "SDK remains the only compaction owner, on the currently selected model. Native compaction may send the existing source to that normal API; this is not permission to send it to Flash or Web.",
                "System/tool schemas and safety reduce history; Completions output is capped at min(model maximum, 2048, quarter window). Codex does not send an output cap: reserve the FULL model catalog maximum (not an enforced cap); opted-in Codex uses SSE with no WebSocket fallback/retries. Current user span/tool chain cannot be silently cut; non-fitting requests stop without HTTP dispatch.",
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
            this.grant = { manager, sessionId };
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
                compactionPaused: this.compactionPaused,
                warmProcessor: this.warmMode ? "flash-per-attempt-review" : "native",
                lastReport: this.lastReport ?? null,
              }),
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
            this.generation++;
            notify(
              ctx,
              "Flash warm selected, NOT authorized. Each native prepared delta needs full source approval and final evidence review; cancel/failure never falls back to native summary. Existing task-memory/website grants are not reused.",
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
              if (!ctx.hasUI || !this.warmRunner) return { cancel: true };
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
              if (event.preparation.previousSummary) {
                const prior = convertToLlm([
                  {
                    role: "compactionSummary",
                    summary: event.preparation.previousSummary,
                    tokensBefore: 0,
                    timestamp: 0,
                  },
                ]);
                if (estimateEnvelope(prior, prior.length).estimatedTokens >= this.policy.warmMax)
                  return { cancel: true };
              }
              const approved = await ctx.ui.confirm(
                "Approve this ONE incremental Flash payload?",
                `Target: ${WARM_TARGET}\nOutput cap ≤2048; thinking disabled; no tools/retries/redirects/cache writes. Network/proxy routing is controlled by Desktop/OS, not a local-only service.\nNo automatic redaction. Includes quoted user/assistant and completed tool data; excludes system/protocol, cold and previous warm. Reasoning/signatures are NOT sent: only visible task text/tool evidence is organized; reasoning stays in native cold history and leaves active replay after approved compaction. No tools executed by Flash. Source permission expires with this attempt.\nSYSTEM:\n${WARM_INSTRUCTIONS}\nUSER:\n${plan.payload}`,
              );
              if (!approved || !authorized()) return { cancel: true };
              const reply = await this.warmRunner({ signal: event.signal, authorized })(plan);
              if (!authorized()) return { cancel: true };
              const candidate = validateWarmAnswer(plan, reply.answer);
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
                "Review omissions BEFORE warm replaces context",
                `Quotes/citations and numeric/name anchors are structurally checked, NOT semantically lossless. Confirm all necessary facts/constraints/order/status are retained; otherwise reject and keep original hot. Only native append changes the active context.\nCANDIDATE:\n${candidate.summary}\nSOURCE:\n${plan.payload}`,
              );
              if (!reviewed || !authorized()) return { cancel: true };
              (candidate.details as { tieredWarm: WarmRecord }).tieredWarm.review = "human-approved-not-proven";
              this.warmCandidate = {
                consentVersion,
                summaryHash: tieredHash(candidate.summary),
                detailsHash: tieredHash(JSON.stringify(candidate.details)),
              };
              return { compaction: { ...candidate, usage: reply.usage } };
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
        pi.on("model_select", () => {
          this.generation++;
          if (this.enabled) this.session?.abortCompaction();
        });
        pi.on("session_start", () => this.disable());
        pi.on("session_before_switch", () => this.disable());
        pi.on("session_before_tree", () => this.disable());
        pi.on("session_before_fork", () => this.disable());
        pi.on("session_shutdown", () => this.disable());
      },
    };
  }
}
