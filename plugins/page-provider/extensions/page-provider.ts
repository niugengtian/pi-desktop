import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  latestUserInput,
  openPageProviderConversation,
  probePageProvider,
  runPageProviderTurn,
  startNewPageProviderConversation,
} from "../src/bridge.mjs";
import {
  CHECKPOINT_ENTRY_TYPE,
  HANDOFF_ENTRY_TYPE,
  UNCONFIRMED_TURN_MARKER,
  buildIncrementalHandoff,
  buildWebContextRequest,
  checkpointFrom,
  consumeLegacyHandoffAcknowledgement,
  createCheckpoint,
  planConversationRoute,
  shouldDedupeRetry,
  validateWebPrompt,
} from "../src/continuity.mjs";
import {
  WEB_CONTRACT,
  DELIVERY_ENTRY_TYPE,
  acceptTieredPayload,
  requireTieredReceipt,
} from "../src/tiered-contract.mjs";
type TieredOptions = SimpleStreamOptions & {
  pageProjection?: Record<string, unknown>;
  pageBeforeDispatch?: (request: unknown) => void;
  pageOnReceipt?: (receipt: unknown, markdown: string) => void;
};

const sourceBridge = fileURLToPath(new URL("../bridge/opencli-bridge.mjs", import.meta.url));
const bundledBridge = existsSync(sourceBridge)
  ? sourceBridge
  : fileURLToPath(new URL("./page-provider-bridge.mjs", import.meta.url));

const BINDING_ENTRY_TYPE = "page-provider-binding";
const PROVISIONAL_BINDING_ENTRY_TYPE = "page-provider-binding-provisional";
const BINDING_RESET_ENTRY_TYPE = "page-provider-binding-reset";
const ROUTE_CANDIDATE_ENTRY_TYPE = "page-provider-route-candidate";
const ROUTE_CHOICE_ENTRY_TYPE = "page-provider-route-choice";
const SESSION_TITLE_FALLBACK_LENGTH = 48;

const activePageTurns = new Set<{
  taskId: string;
  controller: AbortController;
}>();

function abortPageTurnsOutsideTask(taskId: string) {
  for (const active of activePageTurns) {
    if (active.taskId !== taskId) active.controller.abort();
  }
}

type PageRemote = {
  site: string;
  mode: string;
  conversationId?: string;
  conversationUrl?: string;
};

type ProviderBinding = {
  schemaVersion: 1;
  sessionId: string;
  modelId: string;
  assistantEntryId?: string;
  lastSyncedCheckpoint?: number;
  remote: PageRemote;
  updatedAt: string;
};

type TaskCheckpoint = {
  schemaVersion: 1;
  taskId: string;
  sequence: number;
  transcriptEntryId: string;
  modelId: string;
  inputHash: string;
  outputHash: string;
  requestSummary: string;
  outcomeSummary: string;
  createdAt: string;
};

type HandoffBundle = {
  text: string;
  fromCheckpoint: number;
  throughCheckpoint: number;
  checkpointCount: number;
  includedCheckpointCount: number;
};

type CompletedPageTurn = {
  modelId: string;
  remote: PageRemote;
  userText: string;
  assistantText: string;
  handoff?: HandoffBundle;
  handoffAcknowledged: boolean;
  tieredDelivery?: Record<string, unknown>;
};

function bindingFrom(value: unknown): ProviderBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const binding = value as Partial<ProviderBinding>;
  if (binding.schemaVersion !== 1 || typeof binding.modelId !== "string") return undefined;
  if (!binding.remote || typeof binding.remote.site !== "string") return undefined;
  if (typeof binding.remote.conversationUrl !== "string") return undefined;
  return binding as ProviderBinding;
}

function bindingsFromEntries(entries: Array<Record<string, unknown>>) {
  const values = new Map<string, ProviderBinding>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === BINDING_ENTRY_TYPE || entry.customType === PROVISIONAL_BINDING_ENTRY_TYPE) {
      const binding = bindingFrom(entry.data);
      if (binding) values.set(binding.modelId, binding);
    }
    if (entry.customType === BINDING_RESET_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
      const reset = entry.data as { modelId?: unknown };
      if (typeof reset.modelId === "string") values.delete(reset.modelId);
    }
  }
  return values;
}

function bindingsFromSessionFile(path: string | undefined) {
  if (!path) return new Map<string, ProviderBinding>();
  try {
    const entries = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return bindingsFromEntries(entries);
  } catch {
    return new Map<string, ProviderBinding>();
  }
}

function pageSite(modelId: string) {
  return modelId === "chatgpt-web" ? "chatgpt" : "deepseek";
}

function bridgeLaunch() {
  const override = String(process.env.PI_PAGE_PROVIDER_BRIDGE ?? "").trim();
  if (override) return { command: override, args: ["--stdio"] };

  // A bridge shipped inside app.asar must run with Electron's ASAR-aware
  // runtime, even when this computer also has a system Node installation.
  if (process.versions.electron) {
    return {
      command: process.execPath,
      args: [bundledBridge, "--stdio"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const configuredNode = String(process.env.PI_PAGE_PROVIDER_NODE ?? "").trim();
  if (configuredNode) return { command: configuredNode, args: [bundledBridge, "--stdio"] };
  if (/^node(?:\.exe)?$/i.test(basename(process.execPath))) {
    return { command: process.execPath, args: [bundledBridge, "--stdio"] };
  }
  const candidates = [
    join(homedir(), ".hermes", "node", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  const node = candidates.find((candidate) => existsSync(candidate));
  if (node) return { command: node, args: [bundledBridge, "--stdio"] };
  return { command: "node", args: [bundledBridge, "--stdio"] };
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function streamPageProvider(
  model: Model<Api>,
  context: Context,
  options: TieredOptions | undefined,
  taskId: string,
  checkpoints: TaskCheckpoint[],
  binding: ProviderBinding | undefined,
  handoffBlocked: boolean,
  onCompleted: (turn: CompletedPageTurn) => void,
  onRemoteObserved: (modelId: string, remote: PageRemote) => void,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output = emptyAssistantMessage(model);
    const sessionSwitchController = new AbortController();
    const turnSignal = options?.signal
      ? AbortSignal.any([options.signal, sessionSwitchController.signal])
      : sessionSwitchController.signal;
    const activeTurn = { taskId, controller: sessionSwitchController };
    activePageTurns.add(activeTurn);
    let remoteTurnStarted = false;
    try {
      stream.push({ type: "start", partial: output });
      const input = latestUserInput(context);
      const tiered = options?.pageProjection;
      if (!tiered && (options?.pageBeforeDispatch || options?.pageOnReceipt))
        throw new Error("Incomplete tiered Web options; legacy context fallback is prohibited.");
      if (
        tiered &&
        (!options?.onPayload ||
          !options.pageBeforeDispatch ||
          !options.pageOnReceipt ||
          process.env.PI_PAGE_PROVIDER_BRIDGE)
      )
        throw new Error("Tiered Web requires the bundled gated bridge and complete text policy callbacks.");
      const finalTiered = tiered
        ? acceptTieredPayload(await options!.onPayload!(tiered, model), tiered, taskId, model.id)
        : undefined;
      const webRequest = finalTiered?.text ?? buildWebContextRequest(context, input.text);
      const handoff = finalTiered
        ? undefined
        : (buildIncrementalHandoff({
            taskId,
            targetModelId: model.id,
            checkpoints,
            lastSyncedCheckpoint: binding?.lastSyncedCheckpoint ?? 0,
            currentRequest: webRequest,
          }) as HandoffBundle | undefined);
      if (handoff && handoffBlocked) {
        throw new Error(
          `The previous handoff to ${model.id} was not acknowledged. Run /page-provider-handoff-retry to retry it explicitly.`,
        );
      }
      const prompt = validateWebPrompt(handoff?.text ?? webRequest);
      const failedTurnRetry = shouldDedupeRetry(context.messages, input.text);
      const route = finalTiered
        ? {
            newConversation: finalTiered.newConversation,
            ...(finalTiered.conversationId ? { conversationId: finalTiered.conversationId } : {}),
          }
        : planConversationRoute(binding?.remote.conversationId, failedTurnRetry);
      remoteTurnStarted = true;
      const result = await runPageProviderTurn({
        text: prompt,
        dedupe: finalTiered ? false : Boolean(handoff) || failedTurnRetry,
        ...route,
        ...(finalTiered ? { deliveryContract: WEB_CONTRACT, beforeDispatch: options!.pageBeforeDispatch } : {}),
        images: finalTiered ? finalTiered.attachments.map(({ data, mimeType }) => ({ data, mimeType })) : input.images,
        site: model.id === "chatgpt-web" ? "chatgpt" : "deepseek",
        mode: model.id === "deepseek-reasoner" ? "reasoner" : "chat",
        signal: turnSignal,
        onRemote: (remote: PageRemote) => onRemoteObserved(model.id, remote),
        ...bridgeLaunch(),
      });

      // A completed bridge result is the delivery acknowledgement: the adapter
      // matched this exact prompt to a fully extracted assistant reply. Requiring
      // the web model to echo an in-band marker conflicts with user output
      // constraints such as "reply only with the marker" and falsely blocks a
      // successful handoff. Strip the legacy marker when an older remote reply
      // still includes it, but do not require model cooperation to advance.
      const receipt = finalTiered ? requireTieredReceipt(result, finalTiered) : undefined;
      if (receipt && options!.pageOnReceipt!(receipt, result.markdown) !== undefined)
        throw new Error("Web receipt guard must complete synchronously and throw on refusal.");
      if (turnSignal.aborted) throw new DOMException("Web result was cancelled.", "AbortError");
      const response = handoff
        ? consumeLegacyHandoffAcknowledgement(result.markdown, taskId, handoff.throughCheckpoint)
        : { markdown: result.markdown };
      const displayMarkdown = response.markdown;
      onCompleted({
        modelId: model.id,
        remote: result.remote as PageRemote,
        userText: input.text,
        assistantText: response.markdown,
        handoff,
        handoffAcknowledged: true,
        ...(receipt
          ? {
              tieredDelivery: {
                ...receipt,
                sourceHash: finalTiered.sourceHash,
                projectionHash: finalTiered.projectionHash,
                warmVersion: finalTiered.warmVersion,
                hotSourceEntryIds: finalTiered.hotSourceEntryIds,
              },
            }
          : {}),
      });

      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });
      const block = output.content[contentIndex];
      if (block?.type === "text") block.text = displayMarkdown;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: displayMarkdown,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content: displayMarkdown,
        partial: output,
      });

      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      if (remoteTurnStarted && !turnSignal.aborted) {
        // A browser-backed write may have reached the website even when the
        // bridge cannot confirm its result. Returning a terminal, explicit
        // warning prevents the generic provider retry loop from re-sending a
        // side-effecting request. The hidden marker keeps a later user-initiated
        // retry idempotent through shouldDedupeRetry().
        const cause = error instanceof Error ? error.message : String(error);
        // Preserve the bridge's public diagnostic without exposing prompt text
        // or turning Markdown supplied by an error into active UI content.
        const diagnostic = cause.replace(/[\r\n`<>]/g, " ").slice(0, 600);
        const warning = `<!-- ${UNCONFIRMED_TURN_MARKER} -->\n> **网页回复尚未确认，已停止自动重发。**\n>\n> 原因：${diagnostic}\n>\n> 请求可能已到达网站。请先查看原网页和 \`/page-provider-binding\`，避免重复发送。`;
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex, partial: output });
        const block = output.content[contentIndex];
        if (block?.type === "text") block.text = warning;
        stream.push({ type: "text_delta", contentIndex, delta: warning, partial: output });
        stream.push({ type: "text_end", contentIndex, content: warning, partial: output });
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }
      output.stopReason = turnSignal.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    } finally {
      activePageTurns.delete(activeTurn);
    }
  })();

  return stream;
}

export default function pageProviderExtension(pi: ExtensionAPI) {
  const bindings = new Map<string, ProviderBinding>();
  const routeCandidates = new Map<string, ProviderBinding>();
  const routeChoices = new Map<string, "new" | "continue">();
  const checkpoints: TaskCheckpoint[] = [];
  const blockedHandoffs = new Set<string>();
  let activeTaskId = "";
  let pendingTurn: CompletedPageTurn | undefined;

  const recordRouteChoice = (modelId: string, choice: "new" | "continue") => {
    routeChoices.set(modelId, choice);
    pi.appendEntry(ROUTE_CHOICE_ENTRY_TYPE, {
      schemaVersion: 1,
      taskId: activeTaskId,
      modelId,
      choice,
      createdAt: new Date().toISOString(),
    });
  };

  const activatePreviousBinding = (modelId: string, previous: ProviderBinding) => {
    const binding: ProviderBinding = {
      ...previous,
      sessionId: activeTaskId,
      modelId,
      assistantEntryId: undefined,
      lastSyncedCheckpoint: 0,
      updatedAt: new Date().toISOString(),
    };
    bindings.set(modelId, binding);
    pi.appendEntry(BINDING_ENTRY_TYPE, binding);
    recordRouteChoice(modelId, "continue");
    return binding;
  };

  const startFreshConversation = async (modelId: string, ctx: ExtensionContext) => {
    const site = pageSite(modelId);
    await startNewPageProviderConversation({
      site,
      signal: ctx.signal,
      timeoutMs: 30_000,
      ...bridgeLaunch(),
    });
    bindings.delete(modelId);
    blockedHandoffs.delete(modelId);
    pi.appendEntry(BINDING_RESET_ENTRY_TYPE, {
      schemaVersion: 1,
      taskId: activeTaskId,
      modelId,
      createdAt: new Date().toISOString(),
    });
    recordRouteChoice(modelId, "new");
  };

  pi.on("before_agent_start", (event) => {
    if (pi.getSessionName()?.trim()) return;
    const fallback = [...event.prompt.trim().replace(/\s+/g, " ")].slice(0, SESSION_TITLE_FALLBACK_LENGTH).join("");
    if (fallback) pi.setSessionName(fallback);
  });

  pi.on("session_start", (event, ctx) => {
    const nextTaskId = ctx.sessionManager.getSessionId();
    abortPageTurnsOutsideTask(nextTaskId);
    bindings.clear();
    routeCandidates.clear();
    routeChoices.clear();
    checkpoints.length = 0;
    blockedHandoffs.clear();
    activeTaskId = nextTaskId;
    pendingTurn = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === BINDING_ENTRY_TYPE || entry.customType === PROVISIONAL_BINDING_ENTRY_TYPE) {
        const binding = bindingFrom(entry.data);
        if (binding) bindings.set(binding.modelId, binding);
      }
      if (entry.customType === BINDING_RESET_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
        const reset = entry.data as { modelId?: unknown };
        if (typeof reset.modelId === "string") bindings.delete(reset.modelId);
      }
      if (entry.customType === ROUTE_CANDIDATE_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
        const candidate = entry.data as { modelId?: unknown; binding?: unknown };
        const binding = bindingFrom(candidate.binding);
        if (typeof candidate.modelId === "string" && binding) {
          routeCandidates.set(candidate.modelId, binding);
        }
      }
      if (entry.customType === ROUTE_CHOICE_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
        const route = entry.data as { modelId?: unknown; choice?: unknown };
        if (typeof route.modelId === "string" && (route.choice === "new" || route.choice === "continue")) {
          routeChoices.set(route.modelId, route.choice);
        }
      }
      if (entry.customType === CHECKPOINT_ENTRY_TYPE) {
        const checkpoint = checkpointFrom(entry.data) as TaskCheckpoint | undefined;
        if (checkpoint) checkpoints.push(checkpoint);
      }
      if (entry.customType === HANDOFF_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
        const handoff = entry.data as { targetModelId?: unknown; acknowledged?: unknown; retryEnabled?: unknown };
        if (typeof handoff.targetModelId === "string") {
          if (handoff.acknowledged === true || handoff.retryEnabled === true) {
            blockedHandoffs.delete(handoff.targetModelId);
          } else {
            blockedHandoffs.add(handoff.targetModelId);
          }
        }
      }
    }
    checkpoints.sort((a, b) => a.sequence - b.sequence);

    if ((event.reason === "new" || event.reason === "fork") && event.previousSessionFile) {
      for (const [modelId, previousBinding] of bindingsFromSessionFile(event.previousSessionFile)) {
        if (bindings.has(modelId) || routeCandidates.has(modelId)) continue;
        routeCandidates.set(modelId, previousBinding);
        pi.appendEntry(ROUTE_CANDIDATE_ENTRY_TYPE, {
          schemaVersion: 1,
          taskId: activeTaskId,
          modelId,
          binding: previousBinding,
          sourceSessionId: previousBinding.sessionId,
          createdAt: new Date().toISOString(),
        });
      }
    }
  });

  pi.on("input", async (event, ctx) => {
    const modelId = ctx.model?.provider === "opencli-page" ? ctx.model.id : "";
    if (!modelId || event.source === "extension" || bindings.has(modelId) || routeChoices.has(modelId)) {
      return { action: "continue" };
    }
    const candidate = routeCandidates.get(modelId);
    if (!candidate || !ctx.hasUI) return { action: "continue" };

    const choice = await ctx.ui.select(`Choose the ${pageSite(modelId)} conversation for this PI session`, [
      `Continue previous conversation · ${candidate.remote.conversationId}`,
      "Start a new web conversation",
    ]);
    if (!choice) {
      ctx.ui.notify("Message not sent because no web conversation route was selected.", "warning");
      return { action: "handled" };
    }
    if (choice.startsWith("Continue previous")) {
      activatePreviousBinding(modelId, candidate);
    } else {
      recordRouteChoice(modelId, "new");
    }
    return { action: "continue" };
  });

  pi.on("turn_end", (event, ctx) => {
    const pending = pendingTurn;
    pendingTurn = undefined;
    if (!pending || event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
    if (event.message.provider !== "opencli-page" || event.message.model !== pending.modelId) return;

    const taskId = ctx.sessionManager.getSessionId();
    const assistantEntryId = ctx.sessionManager.getLeafId() ?? undefined;
    if (!assistantEntryId) return;
    if (pending.tieredDelivery) {
      // Delivery evidence is metadata, not another summary/fact store or a legacy cursor advance.
      pi.appendEntry(DELIVERY_ENTRY_TYPE, {
        ...pending.tieredDelivery,
        sessionId: taskId,
        modelId: pending.modelId,
        assistantEntryId,
        createdAt: new Date().toISOString(),
      });
      const binding: ProviderBinding = {
        schemaVersion: 1,
        sessionId: taskId,
        modelId: pending.modelId,
        assistantEntryId,
        lastSyncedCheckpoint: bindings.get(pending.modelId)?.lastSyncedCheckpoint ?? 0,
        remote: pending.remote,
        updatedAt: new Date().toISOString(),
      };
      bindings.set(binding.modelId, binding);
      pi.appendEntry(BINDING_ENTRY_TYPE, binding);
      return;
    }
    const sequence = (checkpoints.at(-1)?.sequence ?? 0) + 1;
    const checkpoint = createCheckpoint({
      taskId,
      sequence,
      transcriptEntryId: assistantEntryId,
      modelId: pending.modelId,
      userText: pending.userText,
      assistantText: pending.assistantText,
    }) as TaskCheckpoint;
    checkpoints.push(checkpoint);
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, checkpoint);

    if (pending.handoff) {
      pi.appendEntry(HANDOFF_ENTRY_TYPE, {
        schemaVersion: 1,
        taskId,
        targetModelId: pending.modelId,
        fromCheckpoint: pending.handoff.fromCheckpoint,
        throughCheckpoint: pending.handoff.throughCheckpoint,
        includedCheckpointCount: pending.handoff.includedCheckpointCount,
        acknowledged: pending.handoffAcknowledged,
        assistantEntryId,
        createdAt: new Date().toISOString(),
      });
      if (pending.handoffAcknowledged) blockedHandoffs.delete(pending.modelId);
      else blockedHandoffs.add(pending.modelId);
    }

    if (pending.remote.conversationUrl) {
      const previousCursor = bindings.get(pending.modelId)?.lastSyncedCheckpoint ?? 0;
      const binding: ProviderBinding = {
        schemaVersion: 1,
        sessionId: taskId,
        modelId: pending.modelId,
        assistantEntryId,
        lastSyncedCheckpoint: pending.handoff && !pending.handoffAcknowledged ? previousCursor : sequence,
        remote: pending.remote,
        updatedAt: new Date().toISOString(),
      };
      bindings.set(binding.modelId, binding);
      pi.appendEntry(BINDING_ENTRY_TYPE, binding);
    }
  });

  pi.registerProvider("opencli-page", {
    name: "OpenCLI Page",
    baseUrl: "page-provider://local",
    apiKey: "page-provider-local",
    api: "opencli-page" as Api,
    streamSimple: Object.assign(
      (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
        streamPageProvider(
          model,
          context,
          options,
          activeTaskId,
          checkpoints,
          bindings.get(model.id),
          blockedHandoffs.has(model.id),
          (turn) => {
            pendingTurn = turn;
          },
          (modelId, remote) => {
            const previous = bindings.get(modelId);
            const binding: ProviderBinding = {
              schemaVersion: 1,
              sessionId: activeTaskId,
              modelId,
              lastSyncedCheckpoint: previous?.lastSyncedCheckpoint ?? 0,
              remote,
              updatedAt: new Date().toISOString(),
            };
            bindings.set(modelId, binding);
            // Keep remote discovery independently auditable. Reusing only the final
            // binding type made a successful turn indistinguishable from a turn
            // whose ID was not persisted until completion.
            pi.appendEntry(PROVISIONAL_BINDING_ENTRY_TYPE, binding);
          },
        ),
      { tieredWebContract: WEB_CONTRACT },
    ),
    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: "chatgpt-web",
        name: "ChatGPT Web",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  });

  pi.registerCommand("page-provider-handoff-retry", {
    description: "Explicitly allow retrying an unacknowledged handoff for the selected model",
    handler: async (_args, ctx) => {
      const modelId = ctx.model?.id ?? "";
      if (!modelId || !blockedHandoffs.has(modelId)) {
        ctx.ui.notify(`No blocked handoff exists for ${modelId || "the selected model"}.`, "info");
        return;
      }
      blockedHandoffs.delete(modelId);
      pi.appendEntry(HANDOFF_ENTRY_TYPE, {
        schemaVersion: 1,
        taskId: activeTaskId,
        targetModelId: modelId,
        retryEnabled: true,
        createdAt: new Date().toISOString(),
      });
      ctx.ui.notify(`The next ${modelId} turn may retry the pending handoff.`, "warning");
    },
  });

  pi.registerCommand("page-provider-task-status", {
    description: "Show task continuity checkpoints and synchronization cursors",
    handler: async (_args, ctx) => {
      const latest = checkpoints.at(-1)?.sequence ?? 0;
      const modelId = ctx.model?.id ?? "";
      const cursor = bindings.get(modelId)?.lastSyncedCheckpoint ?? 0;
      ctx.ui.notify(
        `Task ${activeTaskId || "not initialized"} · checkpoint ${latest} · ${modelId || "no model"} synced through ${cursor}${blockedHandoffs.has(modelId) ? " · handoff blocked" : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("page-provider-binding", {
    description: "Show the remote web conversation bound to the selected model",
    handler: async (_args, ctx) => {
      const modelId = ctx.model?.id ?? "";
      const binding = bindings.get(modelId);
      if (!binding) {
        ctx.ui.notify(`No remote conversation is bound to ${modelId || "the selected model"}.`, "warning");
        return;
      }
      ctx.ui.notify(`${binding.remote.site} · ${binding.remote.conversationUrl}`, "info");
    },
  });

  pi.registerCommand("page-provider-conversation", {
    description: "Choose whether the selected Page Provider starts or continues a web conversation",
    handler: async (args, ctx) => {
      const modelId = ctx.model?.provider === "opencli-page" ? ctx.model.id : "";
      if (!modelId) {
        ctx.ui.notify("Select a Page Provider model first.", "warning");
        return;
      }
      const current = bindings.get(modelId);
      const previous = routeCandidates.get(modelId);
      let action = String(args ?? "")
        .trim()
        .toLowerCase();
      if (!action) {
        const options = [
          ...(current ? [`Continue current · ${current.remote.conversationId}`] : []),
          ...(previous && previous.remote.conversationId !== current?.remote.conversationId
            ? [`Continue previous · ${previous.remote.conversationId}`]
            : []),
          "Start new web conversation",
        ];
        const selected = await ctx.ui.select(`Choose the ${pageSite(modelId)} conversation`, options);
        if (!selected) return;
        action = selected.startsWith("Continue current")
          ? "current"
          : selected.startsWith("Continue previous")
            ? "previous"
            : "new";
      }

      if (!["new", "continue", "current", "previous"].includes(action)) {
        ctx.ui.notify("Use /page-provider-conversation new or /page-provider-conversation continue.", "warning");
        return;
      }

      try {
        if (action === "new") {
          ctx.ui.setStatus("page-provider", `Starting a new ${pageSite(modelId)} conversation…`);
          await startFreshConversation(modelId, ctx);
          ctx.ui.notify(
            "Started a new web conversation. Its ID will bind immediately after the first message is sent.",
            "info",
          );
          return;
        }
        const selectedBinding =
          action === "current" ? current : action === "previous" ? previous : (current ?? previous);
        if (!selectedBinding?.remote.conversationId) {
          ctx.ui.notify("No previous conversation is available for this model.", "warning");
          return;
        }
        const binding =
          selectedBinding === current ? selectedBinding : activatePreviousBinding(modelId, selectedBinding);
        if (selectedBinding === current) recordRouteChoice(modelId, "continue");
        await openPageProviderConversation({
          site: binding.remote.site,
          conversationId: binding.remote.conversationId,
          signal: ctx.signal,
          timeoutMs: 30_000,
          ...bridgeLaunch(),
        });
        ctx.ui.notify(`Continuing ${binding.remote.site} conversation ${binding.remote.conversationId}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not change the web conversation route.", "error");
      } finally {
        ctx.ui.setStatus("page-provider", undefined);
      }
    },
  });

  pi.registerCommand("page-provider-new", {
    description: "Start a fresh web conversation for the selected model",
    handler: async (_args, ctx) => {
      const modelId = ctx.model?.provider === "opencli-page" ? ctx.model.id : "";
      if (!modelId) {
        ctx.ui.notify("Select a Page Provider model first.", "warning");
        return;
      }
      const site = pageSite(modelId);
      ctx.ui.setStatus("page-provider", `Starting a new ${site} conversation…`);
      try {
        await startFreshConversation(modelId, ctx);
        ctx.ui.notify(
          `Started a new ${site} conversation. Its ID will bind immediately after the first message is sent.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not start a new web conversation.", "error");
      } finally {
        ctx.ui.setStatus("page-provider", undefined);
      }
    },
  });

  pi.registerCommand("page-provider-open", {
    description: "Open the remote web conversation bound to the selected model",
    handler: async (_args, ctx) => {
      const modelId = ctx.model?.id ?? "";
      const binding = bindings.get(modelId);
      if (!binding?.remote.conversationId) {
        ctx.ui.notify(`No remote conversation is bound to ${modelId || "the selected model"}.`, "warning");
        return;
      }
      ctx.ui.setStatus("page-provider", `Opening ${binding.remote.site} conversation…`);
      try {
        await openPageProviderConversation({
          site: binding.remote.site,
          conversationId: binding.remote.conversationId,
          signal: ctx.signal,
          timeoutMs: 30_000,
          ...bridgeLaunch(),
        });
        ctx.ui.notify(`Opened ${binding.remote.site} conversation.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not open the remote conversation.", "error");
      } finally {
        ctx.ui.setStatus("page-provider", undefined);
      }
    },
  });

  pi.registerCommand("page-provider-status", {
    description: "Check the selected OpenCLI web page connection",
    handler: async (_args, ctx) => {
      const site = ctx.model?.id === "chatgpt-web" ? "chatgpt" : "deepseek";
      ctx.ui.setStatus("page-provider", `Checking ${site} page…`);
      try {
        const result = await probePageProvider({
          site,
          signal: ctx.signal,
          timeoutMs: 30_000,
          ...bridgeLaunch(),
        });
        ctx.ui.notify(`Page Provider: ${result.state} · ${site}`, result.state === "ready" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Page Provider probe failed.", "error");
      } finally {
        ctx.ui.setStatus("page-provider", undefined);
      }
    },
  });
}
