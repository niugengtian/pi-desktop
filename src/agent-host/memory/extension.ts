import { buildSessionProjection, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { memoryModelHandlers } from "../handlers/memory-model";
import { createLocalMemoryRunner } from "./local-model.mjs";
import { compileTaskMemory } from "./compile.mjs";
import { memoryCandidates, splitMemoryTiers } from "./tiers.mjs";
import { memoryRecordId } from "./markdown-store.mjs";

const ENTRY_TYPE = "pi-desktop-task-memory";

type TaskMemory = {
  source: string;
  sourceHash: string;
  summary: string;
  modelId: string;
  sourceChars: number;
  summaryChars: number;
};

/** Local memory is staged for review, never injected into a provider request implicitly. */
export function createTaskMemoryExtension() {
  return {
    name: "pi-desktop-task-memory",
    hidden: true,
    factory(pi: ExtensionAPI) {
      let current: TaskMemory | undefined;
      let preview: Omit<TaskMemory, "source"> | undefined;
      let stale = false;
      let compiledRevision: { id: string; hash: string; path: string } | undefined;
      let checkpoint: Parameters<typeof compileTaskMemory>[0]["checkpoint"];
      const revisions = new Map<string, { hash: string; path: string }>();

      pi.on("session_start", (_event, ctx) => {
        current = undefined;
        preview = undefined;
        stale = false;
        compiledRevision = undefined;
        checkpoint = null;
        revisions.clear();
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
          const data = entry.data as (Partial<TaskMemory> & { id?: string; hash?: string; path?: string }) | undefined;
          if (
            typeof data?.summary !== "string" ||
            typeof data.sourceHash !== "string" ||
            typeof data.modelId !== "string" ||
            typeof data.summaryChars !== "number"
          )
            continue;
          if (typeof data.path === "string" && typeof data.hash === "string" && typeof data.id === "string") {
            compiledRevision = { id: data.id, hash: data.hash, path: data.path };
            revisions.set(data.id, { hash: data.hash, path: data.path });
            const ledger = entry.data as { schemaVersion?: number; checkpoint?: typeof checkpoint };
            if (ledger.schemaVersion === 2 && ledger.checkpoint) checkpoint = ledger.checkpoint;
          }
          preview = {
            sourceHash: data.sourceHash,
            summary: data.summary,
            modelId: data.modelId,
            sourceChars: typeof data.sourceChars === "number" ? data.sourceChars : 0,
            summaryChars: data.summaryChars,
          };
        }
      });

      pi.on("turn_end", async (event, ctx) => {
        if (event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
        let settings;
        try {
          settings = memoryModelHandlers.get().settings;
        } catch (error) {
          stale = true;
          ctx.ui.notify(`Task memory configuration error: ${String(error)}`, "error");
          return;
        }
        if (!settings.enabled) {
          stale = true;
          return;
        }
        stale = true;
        try {
          ctx.ui.setStatus("task-memory", "Updating local task memory…");
          const run = await createLocalMemoryRunner({ signal: ctx.signal });
          const branchLeafId = ctx.sessionManager.getLeafId();
          if (!branchLeafId) throw new Error("No current Pi branch leaf; memory file not written.");
          const entries = ctx.sessionManager.getBranch();
          const projection = buildSessionProjection(entries, branchLeafId);
          const candidates = memoryCandidates(projection, {
            sessionId: ctx.sessionManager.getSessionId(),
            branchLeafId,
          });
          if (candidates.at(-1)?.role === "user") candidates.pop();
          const { hot, warmCandidates } = splitMemoryTiers(candidates);
          const selected = warmCandidates.length > 0 ? warmCandidates : hot;
          const nextId =
            selected.length > 0
              ? memoryRecordId(
                  ctx.sessionManager.getSessionId(),
                  selected.map((item) => item.entryId),
                )
              : undefined;
          const sameRecord = Boolean(nextId && nextId === compiledRevision?.id);
          const result = await compileTaskMemory({
            entries,
            branchLeafId,
            sessionId: ctx.sessionManager.getSessionId(),
            settings,
            run,
            root: join(getAgentDir(), "task-memory-vault"),
            // The Markdown file is authoritative; only reuse a revision for the
            // same derived record. A changed branch gets a new provenance ID.
            expectedHash: nextId ? (revisions.get(nextId)?.hash ?? null) : null,
            previous: sameRecord ? (current ?? null) : null,
            checkpoint,
            onFailure: (id, error) =>
              ctx.ui.notify(
                `Task memory model ${id} failed; ${settings.fallback ? "trying configured backup" : "no backup is configured"}: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              ),
          });
          if (!result) return;
          current = result.memory;
          stale = false;
          compiledRevision = { id: result.record.id, hash: result.hash, path: result.path };
          preview = {
            sourceHash: result.memory.sourceHash,
            summary: result.memory.summary,
            modelId: result.memory.modelId,
            sourceChars: result.memory.sourceChars,
            summaryChars: result.memory.summaryChars,
          };
          const ledgerChanged =
            checkpoint?.branchCursor?.fingerprint !== result.branchCursor.fingerprint ||
            checkpoint?.memory.sourceHash !== result.memory.sourceHash;
          checkpoint = {
            ...compiledRevision,
            tier: result.record.tier,
            cursor: result.cursor,
            branchCursor: result.branchCursor,
            memory: preview,
          };
          revisions.set(result.record.id, { hash: result.hash, path: result.path });
          if (!result.unchanged || ledgerChanged)
            pi.appendEntry(ENTRY_TYPE, {
              schemaVersion: 2,
              ...preview,
              ...compiledRevision,
              checkpoint,
              createdAt: new Date().toISOString(),
            });
          ctx.ui.setStatus("task-memory", `Memory: ${result.path} (${result.memory.summaryChars} chars)`);
        } catch (error) {
          stale = true;
          ctx.ui.notify(
            `Local task memory update failed; no new summary was delivered: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          ctx.ui.setStatus("task-memory", "Memory update failed");
        }
      });

      pi.registerCommand("task-memory-preview", {
        description: "View the local task memory and source/summary size",
        handler: async (_args, ctx) => {
          if (!preview) {
            ctx.ui.notify("No local task memory is available yet.", "info");
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
