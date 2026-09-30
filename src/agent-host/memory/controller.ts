import {
  buildSessionProjection,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createTaskMemoryExtension } from "./extension";
import { installMemoryRequestGuard } from "./request-guard";
import type { Model, Api, TranscriptContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { memoryModelHandlers } from "../handlers/memory-model";
import { createLocalMemoryRunner } from "./local-model.mjs";
import { compileTaskMemory } from "./compile.mjs";
import { isWebMemoryModel, latestMemoryLedger, prepareMemoryDelivery } from "./delivery.mjs";
import { memoryCandidates, memoryCursor, planMemoryDelivery, splitMemoryTiers } from "./tiers.mjs";
import { memoryRecordId } from "./markdown-store.mjs";
import { registerMemoryRetrieval } from "./retrieval";

export function createDesktopMemoryDelivery(agentDir: string) {
  const controller = createMemoryDeliveryController(join(agentDir, "task-memory-vault"));
  return {
    extensions: [controller.extension, createTaskMemoryExtension()],
    install(runtime: Pick<ModelRuntime, "streamSimple">) {
      installMemoryRequestGuard(runtime, controller.prepare, controller.delivered, controller.blocked);
    },
  };
}

export function createMemoryDeliveryController(root: string) {
  let ctx: ExtensionContext | undefined;
  let pi: ExtensionAPI | undefined;
  let from: { provider: string; modelId: string } | null = null;

  function source() {
    if (!ctx) throw new Error("Memory delivery has no active session.");
    const entries = ctx.sessionManager.getBranch();
    const branchLeafId = ctx.sessionManager.getLeafId();
    if (!branchLeafId) throw new Error("Memory delivery has no branch.");
    const sessionId = ctx.sessionManager.getSessionId();
    const candidates = memoryCandidates(buildSessionProjection(entries, branchLeafId), { sessionId, branchLeafId });
    if (candidates.at(-1)?.role === "user") candidates.pop();
    return { entries, branchLeafId, sessionId, candidates, fingerprint: memoryCursor(candidates).fingerprint };
  }

  async function refresh(signal?: AbortSignal) {
    const selected = source();
    if (!selected.candidates.length) return null;
    const ledger = latestMemoryLedger(selected.entries);
    const settings = memoryModelHandlers.get().settings;
    if (!settings.enabled) throw new Error("Memory is disabled; staged delivery stopped.");
    const run = await createLocalMemoryRunner({ signal });
    const tiers = splitMemoryTiers(selected.candidates);
    const staged = tiers.warmCandidates.length ? tiers.warmCandidates : tiers.hot;
    const nextId = memoryRecordId(
      selected.sessionId,
      staged.map((item) => item.entryId),
    );
    const revision = selected.entries.findLast(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-desktop-task-memory" &&
        (entry.data as { id?: string })?.id === nextId,
    );
    const expectedHash = revision?.type === "custom" ? ((revision.data as { hash?: string }).hash ?? null) : null;
    const result = await compileTaskMemory({ ...selected, root, settings, run, checkpoint: ledger, expectedHash });
    if (!result) throw new Error("No local memory was produced.");
    const { source: _source, ...memory } = result.memory;
    const checkpoint = {
      id: result.record.id,
      path: result.path,
      hash: result.hash,
      tier: result.record.tier,
      cursor: result.cursor,
      branchCursor: result.branchCursor,
      memory,
    };
    if (
      !result.unchanged ||
      ledger?.branchCursor.fingerprint !== result.branchCursor.fingerprint ||
      ledger?.memory.sourceHash !== memory.sourceHash
    )
      pi!.appendEntry("pi-desktop-task-memory", {
        schemaVersion: 2,
        ...memory,
        id: checkpoint.id,
        path: checkpoint.path,
        hash: checkpoint.hash,
        checkpoint,
        createdAt: new Date().toISOString(),
      });
    return checkpoint;
  }

  return {
    extension: {
      name: "pi-desktop-memory-delivery",
      hidden: true,
      factory(api: ExtensionAPI) {
        pi = api;
        registerMemoryRetrieval(api, root);
        api.on("session_start", (_event, context) => {
          ctx = context;
          const last = context.sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
            );
          if (last?.type === "message" && last.message.role === "assistant")
            from = { provider: last.message.provider, modelId: last.message.model };
          else from = null; // Selecting an unused model is not a history handoff.
        });
        api.on("model_select", (_event, context) => {
          ctx = context;
        });
        api.on("before_agent_start", (_event, context) => {
          ctx = context;
        });
        api.registerCommand("task-memory-refresh", {
          description: "Rebuild/verify local task memory without sending it to a provider",
          handler: async (_args, context) => {
            ctx = context;
            try {
              await refresh(context.signal);
              context.ui.notify("Local memory verified.", "info");
            } catch (error) {
              context.ui.notify(String(error), "error");
            }
          },
        });
      },
    },
    blocked(error: unknown) {
      ctx?.ui.notify(`Memory delivery blocked: ${String(error)}`, "error");
    },
    delivered(model: Model<Api>) {
      from = { provider: model.provider, modelId: model.id };
    },
    async prepare(
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): Promise<TranscriptContext> {
      if (!ctx) throw new Error("Memory delivery session is not initialized.");
      const web = isWebMemoryModel(model);
      const reportedTokens = ctx.getContextUsage()?.tokens ?? null;
      // Pi may report no usage for a fresh or tool-calling turn. Serialized
      // UTF-8 bytes still provide a conservative text-token upper bound, so
      // normal same-provider API tool continuation need not discard its tools.
      const estimatedTokens =
        from === null && source().candidates.length > 0
          ? null
          : Math.max(reportedTokens ?? 0, Buffer.byteLength(JSON.stringify(context.messages)));
      const plan = planMemoryDelivery({
        from,
        to: { provider: model.provider, modelId: model.id },
        estimatedTokens,
        contextWindow: model.contextWindow,
      });
      if (!web && plan.mode === "normal") return context;
      if (!ctx.hasUI) throw new Error("Staged memory requires a supported approval UI; nothing was sent.");
      let selected = source();
      let ledger = latestMemoryLedger(selected.entries);
      if (selected.candidates.length && ledger?.branchCursor.fingerprint !== selected.fingerprint) {
        ledger = await refresh(options?.signal);
        selected = source();
      }
      const output = await prepareMemoryDelivery({
        ...selected,
        model,
        context,
        from,
        estimatedTokens,
        root,
        ledger,
        web,
        signal: options?.signal,
        approve: async (preview) =>
          ctx!.ui.confirm(`Approve memory delivery → ${preview.target} (${preview.reason})`, preview.text),
      });
      const afterApproval = source();
      if (
        afterApproval.sessionId !== selected.sessionId ||
        afterApproval.branchLeafId !== selected.branchLeafId ||
        afterApproval.fingerprint !== selected.fingerprint ||
        ctx.model?.provider !== model.provider ||
        ctx.model?.id !== model.id
      )
        throw new Error("Session or model changed during approval; nothing was sent.");
      if (web && output.receipt)
        pi!.events.emit("pi-desktop:memory-approved", {
          ...output.receipt,
          sessionId: selected.sessionId,
        });
      return output.context;
    },
  };
}
