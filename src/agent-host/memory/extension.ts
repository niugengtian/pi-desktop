import {
  buildSessionProjection,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { setImmediate, clearImmediate } from "node:timers";
import { memoryModelHandlers, memoryModelConsentEpoch } from "../handlers/memory-model";
import { createLocalMemoryRunner } from "./local-model.mjs";
import { createFlashMemoryRunner, FLASH_MEMORY_MODEL, remoteSourcePreview } from "./remote-model.mjs";
import { compileTaskMemory } from "./compile.mjs";
import { memoryCandidates, splitMemoryTiers } from "./tiers.mjs";
import { memoryRecordId, writeMemoryMarkdown } from "./markdown-store.mjs";
import type { TaskMemoryResult } from "./task-memory.mjs";

const ENTRY_TYPE = "pi-desktop-task-memory";

/** Task memory is staged for review, never injected into main-chat context implicitly. */
export function createTaskMemoryExtension({
  getRemoteRuntime = () => undefined,
  onRemoteEvent = () => {},
}: {
  getRemoteRuntime?: () => ModelRuntime | Promise<ModelRuntime> | undefined;
  onRemoteEvent?: (event: { phase: string; at: string; status?: number }) => void;
} = {}) {
  return {
    name: "pi-desktop-task-memory",
    hidden: true,
    factory(pi: ExtensionAPI) {
      let current: TaskMemoryResult | undefined;
      let preview: Omit<TaskMemoryResult, "source"> | undefined;
      let stale = false;
      let pending = false;
      let remoteConsent:
        { manager: ExtensionContext["sessionManager"]; sessionId: string; version: string; epoch: number } | undefined;
      const hasRemoteConsent = (ctx: ExtensionContext, version: string) => {
        if (remoteConsent && (remoteConsent.version !== version || remoteConsent.epoch !== memoryModelConsentEpoch())) {
          remoteConsent = undefined;
        }
        return Boolean(
          remoteConsent &&
          remoteConsent.manager === ctx.sessionManager &&
          remoteConsent.sessionId === ctx.sessionManager.getSessionId(),
        );
      };
      let compiledRevision: { id: string; hash: string; path: string } | undefined;
      let job:
        | {
            controller: AbortController;
            timer?: ReturnType<typeof setImmediate>;
            detach: () => void;
          }
        | undefined;

      const status = (ctx: ExtensionContext, text?: string) => {
        try {
          ctx.ui.setStatus("task-memory", text);
        } catch {
          // Session replacement invalidates guarded UI/context getters.
        }
      };
      const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" | "error") => {
        try {
          ctx.ui.notify(text, type);
        } catch {
          // Optional background diagnostics must not reject the chat lifecycle.
        }
      };
      const cancel = (ctx: ExtensionContext) => {
        pending = false;
        const previous = job;
        job = undefined;
        if (!previous) return;
        stale = true;
        if (previous.timer) clearImmediate(previous.timer);
        previous.detach();
        previous.controller.abort();
        status(ctx);
      };
      const revokeRemote = (ctx: ExtensionContext) => {
        remoteConsent = undefined;
        cancel(ctx);
      };
      const restore = (ctx: ExtensionContext) => {
        revokeRemote(ctx);
        current = undefined;
        preview = undefined;
        stale = false;
        compiledRevision = undefined;
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
          const data = entry.data as
            (Partial<TaskMemoryResult> & { id?: string; hash?: string; path?: string }) | undefined;
          if (
            typeof data?.summary !== "string" ||
            typeof data.sourceHash !== "string" ||
            typeof data.modelId !== "string" ||
            typeof data.summaryChars !== "number"
          )
            continue;
          if (typeof data.path === "string" && typeof data.hash === "string" && typeof data.id === "string") {
            compiledRevision = { id: data.id, hash: data.hash, path: data.path };
          }
          preview = {
            sourceHash: data.sourceHash,
            summary: data.summary,
            modelId: data.modelId,
            sourceChars: typeof data.sourceChars === "number" ? data.sourceChars : 0,
            summaryChars: data.summaryChars,
          };
        }
      };

      const schedule = (ctx: ExtensionContext) => {
        cancel(ctx);
        let snapshot;
        try {
          snapshot = memoryModelHandlers.get();
        } catch (error) {
          stale = true;
          notify(ctx, `Task memory configuration error: ${String(error)}`, "error");
          return;
        }
        if (!snapshot.settings.enabled || !ctx.isIdle()) return;
        const remote = snapshot.settings.primary === FLASH_MEMORY_MODEL;
        if (remote && (snapshot.settings.fallback || !hasRemoteConsent(ctx, snapshot.version))) {
          stale = true;
          status(ctx, "Remote memory is paused; use /task-memory-enable-remote to review and approve sources.");
          return;
        }
        const manager = ctx.sessionManager;
        const sessionId = manager.getSessionId();
        const branchLeafId = manager.getLeafId();
        if (!branchLeafId) return;
        const entries = manager.getBranch();
        const root = join(getAgentDir(), "task-memory-vault");
        const operationSignal = ctx.signal;
        if (operationSignal?.aborted) return;
        const controller = new AbortController();
        const task = { controller, timer: undefined as ReturnType<typeof setImmediate> | undefined, detach: () => {} };
        const onAbort = () => {
          if (job === task) cancel(ctx);
        };
        operationSignal?.addEventListener("abort", onAbort, { once: true });
        task.detach = () => operationSignal?.removeEventListener("abort", onAbort);
        job = task;
        stale = true;
        const isCurrent = () => {
          try {
            return (
              job === task &&
              !controller.signal.aborted &&
              ctx.sessionManager === manager &&
              manager.getSessionId() === sessionId &&
              manager.getLeafId() === branchLeafId &&
              ctx.isIdle() &&
              (!remote || hasRemoteConsent(ctx, snapshot.version)) &&
              memoryModelHandlers.get().version === snapshot.version
            );
          } catch {
            return false;
          }
        };
        const update = async () => {
          let failed = false;
          try {
            if (!isCurrent()) return;
            const sourceCandidates = (branch: typeof entries) => {
              const projection = buildSessionProjection(branch, branchLeafId);
              const items = memoryCandidates(projection, { sessionId, branchLeafId });
              if (items.at(-1)?.role === "user") items.pop();
              return items;
            };
            const fingerprint = (items: ReturnType<typeof memoryCandidates>) =>
              JSON.stringify(items.map(({ entryId, role, sourceHash }) => [entryId, role, sourceHash]));
            const candidates = sourceCandidates(entries);
            const sourceFingerprint = fingerprint(candidates);
            const { hot, warmCandidates } = splitMemoryTiers(candidates);
            const selected = warmCandidates.length > 0 ? warmCandidates : hot;
            if (remote) remoteSourcePreview(selected); // Fail closed before credentials/network for disallowed sources.
            const runtime = remote ? await getRemoteRuntime() : undefined;
            if (!isCurrent()) return;
            const run = remote
              ? createFlashMemoryRunner({
                  runtime: runtime!,
                  signal: controller.signal,
                  authorized: () =>
                    isCurrent() && fingerprint(sourceCandidates(manager.getBranch())) === sourceFingerprint,
                  onEvent: (event) => {
                    try {
                      onRemoteEvent(event);
                    } catch {
                      /* optional validation observer */
                    }
                  },
                })
              : await createLocalMemoryRunner({ signal: controller.signal });
            if (!isCurrent()) return;
            const nextId =
              selected.length > 0
                ? memoryRecordId(
                    sessionId,
                    selected.map((item) => item.entryId),
                  )
                : undefined;
            const sameRecord = Boolean(nextId && nextId === compiledRevision?.id);
            const expectedHash = sameRecord ? compiledRevision!.hash : null;
            await compileTaskMemory({
              entries,
              branchLeafId,
              sessionId,
              settings: snapshot.settings,
              run,
              root,
              signal: controller.signal,
              expectedHash,
              previous: !remote && sameRecord ? (current ?? null) : null,
              onFailure: (id, error) => {
                if (isCurrent())
                  notify(
                    ctx,
                    `Task memory model ${id} failed; ${snapshot.settings.fallback ? "trying configured backup" : "no backup is configured"}: ${error instanceof Error ? error.message : String(error)}`,
                    "warning",
                  );
              },
              // No await is allowed between validation, Markdown write and ledger append.
              // A provider may ignore abort; a late result must still not commit.
              commit: (record, memory) => {
                if (!isCurrent() || fingerprint(sourceCandidates(manager.getBranch())) !== sourceFingerprint) {
                  controller.abort();
                  throw new Error("Task memory source or settings changed; nothing was written.");
                }
                const saved = writeMemoryMarkdown(root, record, expectedHash);
                const nextPreview = {
                  sourceHash: memory.sourceHash,
                  summary: memory.summary,
                  modelId: memory.modelId,
                  sourceChars: memory.sourceChars,
                  summaryChars: memory.summaryChars,
                };
                pi.appendEntry(ENTRY_TYPE, {
                  schemaVersion: 1,
                  ...nextPreview,
                  id: record.id,
                  hash: saved.hash,
                  path: saved.path,
                  createdAt: new Date().toISOString(),
                });
                current = memory;
                compiledRevision = { id: record.id, hash: saved.hash, path: saved.path };
                preview = nextPreview;
                stale = false;
                status(ctx, `Memory: ${saved.path} (${memory.summaryChars} chars)`);
                return saved;
              },
            });
          } catch (error) {
            if (isCurrent()) {
              failed = true;
              notify(
                ctx,
                `Local task memory update failed; no new summary was delivered: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
          } finally {
            task.detach();
            if (job === task) {
              job = undefined;
              if (stale) status(ctx, failed ? "Memory update failed" : undefined);
            }
          }
        };
        status(
          ctx,
          remote
            ? "Updating task memory via DeepSeek Flash (thinking off); chat can continue…"
            : "Updating local task memory in background; chat can continue…",
        );
        task.timer = setImmediate(() => {
          task.timer = undefined;
          void update();
        });
      };

      pi.on("session_start", (_event, ctx) => restore(ctx));
      pi.on("session_tree", (_event, ctx) => restore(ctx));
      pi.on("session_compact", (_event, ctx) => restore(ctx));
      pi.on("session_before_switch", (_event, ctx) => revokeRemote(ctx));
      pi.on("session_before_fork", (_event, ctx) => revokeRemote(ctx));
      pi.on("session_before_tree", (_event, ctx) => revokeRemote(ctx));
      pi.on("session_before_compact", (_event, ctx) => revokeRemote(ctx));
      pi.on("session_shutdown", (_event, ctx) => revokeRemote(ctx));
      pi.on("before_agent_start", (_event, ctx) => {
        cancel(ctx);
        stale = true;
      });
      pi.on("turn_start", (_event, ctx) => cancel(ctx));
      pi.on("turn_end", (event) => {
        pending = event.message.role === "assistant" && event.message.stopReason === "stop";
      });
      pi.on("agent_settled", (_event, ctx) => {
        if (pending) schedule(ctx);
      });

      pi.registerCommand("task-memory-enable-remote", {
        description: "Review source and authorize DeepSeek Flash off for this session only",
        handler: async (_args, ctx) => {
          revokeRemote(ctx);
          try {
            const snapshot = memoryModelHandlers.get();
            const epoch = memoryModelConsentEpoch();
            if (
              !snapshot.settings.enabled ||
              snapshot.settings.primary !== FLASH_MEMORY_MODEL ||
              snapshot.settings.fallback
            ) {
              notify(ctx, "Choose deepseek/deepseek-flash as enabled primary with no fallback first.", "warning");
              return;
            }
            const manager = ctx.sessionManager;
            const sessionId = manager.getSessionId();
            const leaf = manager.getLeafId();
            if (!leaf) return;
            const candidates = memoryCandidates(buildSessionProjection(manager.getBranch(), leaf), {
              sessionId,
              branchLeafId: leaf,
            });
            if (candidates.at(-1)?.role === "user") candidates.pop();
            const { hot, warmCandidates } = splitMemoryTiers(candidates);
            const source = remoteSourcePreview(warmCandidates.length ? warmCandidates : hot);
            const accepted = await ctx.ui.confirm(
              "Allow DeepSeek V4.1 Flash background memory for this session?",
              `Destination: https://api.deepseek.com (API usage charges; thinking disabled).\n\nCurrent source, unredacted (${source.length} characters):\n${source}\n\nAllow completed user/assistant text in this session, including FUTURE text, to be summarized by DeepSeek. No tools, attachments, compaction or branch summary sources. Up to 12000 source characters. Output privacy instructions do NOT redact input; do not paste secrets. Session switch, branch navigation, compaction, settings change, restart or /task-memory-disable-remote revokes permission. No other remote provider or fallback.`,
            );
            if (
              !accepted ||
              ctx.sessionManager !== manager ||
              manager.getSessionId() !== sessionId ||
              manager.getLeafId() !== leaf ||
              memoryModelHandlers.get().version !== snapshot.version ||
              memoryModelConsentEpoch() !== epoch
            )
              return;
            remoteConsent = { manager, sessionId, version: snapshot.version, epoch };
            schedule(ctx);
          } catch {
            notify(ctx, "Remote memory approval failed or source is unsupported; no source was sent.", "error");
          }
        },
      });
      pi.registerCommand("task-memory-disable-remote", {
        description: "Revoke remote task memory permission for this session",
        handler: async (_args, ctx) => {
          revokeRemote(ctx);
          notify(ctx, "Remote memory permission revoked; chat history was preserved.", "info");
        },
      });

      pi.registerCommand("task-memory-cancel", {
        description: "Cancel background local memory work without deleting chat history",
        handler: async (_args, ctx) => {
          const active = Boolean(job || pending);
          cancel(ctx);
          ctx.ui.notify(
            active
              ? "Background task memory cancelled; chat history was preserved."
              : "No background memory task is pending; chat history was preserved.",
            "info",
          );
        },
      });
      pi.registerCommand("task-memory-preview", {
        description: "View the local task memory and source/summary size",
        handler: async (_args, ctx) => {
          if (!preview) {
            ctx.ui.notify(
              job
                ? "Local task memory is updating in the background; chat can continue."
                : "No local task memory is available yet.",
              "info",
            );
            return;
          }
          await ctx.ui.confirm(
            `Task memory (${preview.modelId}${stale ? ", stale — not current" : ""})`,
            `Source: ${preview.sourceChars} characters. Summary: ${preview.summaryChars}/4000 characters.\n\n${preview.summary}`,
          );
        },
      });
    },
  };
}
