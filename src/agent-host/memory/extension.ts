import {
  buildSessionProjection,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { setImmediate, clearImmediate } from "node:timers";
import { memoryModelHandlers } from "../handlers/memory-model";
import { createLocalMemoryRunner } from "./local-model.mjs";
import { compileTaskMemory } from "./compile.mjs";
import { memoryCandidates, splitMemoryTiers } from "./tiers.mjs";
import { memoryRecordId, writeMemoryMarkdown } from "./markdown-store.mjs";
import type { TaskMemoryResult } from "./task-memory.mjs";

const ENTRY_TYPE = "pi-desktop-task-memory";

/** Local memory is staged for review, never injected into a provider request implicitly. */
export function createTaskMemoryExtension() {
  return {
    name: "pi-desktop-task-memory",
    hidden: true,
    factory(pi: ExtensionAPI) {
      let current: TaskMemoryResult | undefined;
      let preview: Omit<TaskMemoryResult, "source"> | undefined;
      let stale = false;
      let pending = false;
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
      const restore = (ctx: ExtensionContext) => {
        cancel(ctx);
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
            const run = await createLocalMemoryRunner({ signal: controller.signal });
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
              previous: sameRecord ? (current ?? null) : null,
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
        status(ctx, "Updating local task memory in background; chat can continue…");
        task.timer = setImmediate(() => {
          task.timer = undefined;
          void update();
        });
      };

      pi.on("session_start", (_event, ctx) => restore(ctx));
      pi.on("session_tree", (_event, ctx) => restore(ctx));
      pi.on("session_compact", (_event, ctx) => restore(ctx));
      pi.on("session_before_switch", (_event, ctx) => cancel(ctx));
      pi.on("session_before_fork", (_event, ctx) => cancel(ctx));
      pi.on("session_before_tree", (_event, ctx) => cancel(ctx));
      pi.on("session_before_compact", (_event, ctx) => cancel(ctx));
      pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
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

      pi.registerCommand("task-memory-cancel", {
        description: "Cancel background local memory work without deleting chat history",
        handler: async (_args, ctx) => {
          cancel(ctx);
          ctx.ui.notify("Background task memory cancelled; chat history was preserved.", "info");
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
            `Local task memory (${preview.modelId}${stale ? ", stale — not sent" : ""})`,
            `Source: ${preview.sourceChars} characters. Summary: ${preview.summaryChars}/4000 characters.\n\n${preview.summary}`,
          );
        },
      });
    },
  };
}
