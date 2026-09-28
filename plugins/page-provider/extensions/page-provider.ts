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
  checkpointFrom,
  consumeHandoffAcknowledgement,
  createCheckpoint,
  planConversationRoute,
  shouldDedupeRetry,
} from "../src/continuity.mjs";

const bundledBridge = fileURLToPath(new URL("../bridge/opencli-bridge.mjs", import.meta.url));

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

function nodeExecutable() {
  const configured = String(process.env.PI_PAGE_PROVIDER_NODE ?? "").trim();
  if (configured) return configured;
  if (/^node(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
  const candidates = [
    join(homedir(), ".hermes", "node", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "node";
}

function bridgeLaunch() {
  const override = String(process.env.PI_PAGE_PROVIDER_BRIDGE ?? "").trim();
  if (override) return { command: override, args: ["--stdio"] };
  return { command: nodeExecutable(), args: [bundledBridge, "--stdio"] };
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
  options: SimpleStreamOptions | undefined,
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
      const handoff = buildIncrementalHandoff({
        taskId,
        targetModelId: model.id,
        checkpoints,
        lastSyncedCheckpoint: binding?.lastSyncedCheckpoint ?? 0,
        currentRequest: input.text,
      }) as HandoffBundle | undefined;
      if (handoff && handoffBlocked) {
        throw new Error(
          `The previous handoff to ${model.id} was not acknowledged. Run /page-provider-handoff-retry to retry it explicitly.`,
        );
      }
      const failedTurnRetry = shouldDedupeRetry(context.messages, input.text);
      const route = planConversationRoute(binding?.remote.conversationId, failedTurnRetry);
      remoteTurnStarted = true;
      const result = await runPageProviderTurn({
        text: handoff?.text ?? input.text,
        dedupe: Boolean(handoff) || failedTurnRetry,
        ...route,
        images: input.images,
        site: model.id === "chatgpt-web" ? "chatgpt" : "deepseek",
        mode: model.id === "deepseek-reasoner" ? "reasoner" : "chat",
        signal: turnSignal,
        onRemote: (remote: PageRemote) => onRemoteObserved(model.id, remote),
        ...bridgeLaunch(),
      });

      const acknowledgement = handoff
        ? consumeHandoffAcknowledgement(result.markdown, taskId, handoff.throughCheckpoint)
        : { acknowledged: true, markdown: result.markdown };
      const displayMarkdown = acknowledgement.acknowledged
        ? acknowledgement.markdown
        : `> **Task handoff was delivered but not acknowledged.** The synchronization cursor was not advanced.\n\n${result.markdown}`;
      onCompleted({
        modelId: model.id,
        remote: result.remote as PageRemote,
        userText: input.text,
        assistantText: acknowledgement.markdown,
        handoff,
        handoffAcknowledged: acknowledgement.acknowledged,
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
        const warning = `<!-- ${UNCONFIRMED_TURN_MARKER} -->\n> **Web turn status is unconfirmed; automatic retry was stopped.**\n>\n> The website may already have received this request. Check the web page and \`/page-provider-binding\` before retrying explicitly.`;
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
    streamSimple: (model, context, options) =>
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
