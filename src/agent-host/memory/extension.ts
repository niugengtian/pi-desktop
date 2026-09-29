import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryModelHandlers } from "../handlers/memory-model";
import { createLocalMemoryRunner } from "./local-model.mjs";
import { updateTaskMemory } from "./task-memory.mjs";

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

      pi.on("session_start", (_event, ctx) => {
        current = undefined;
        preview = undefined;
        stale = false;
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
          const data = entry.data as Partial<TaskMemory> | undefined;
          if (typeof data?.summary !== "string" || typeof data.sourceHash !== "string"
            || typeof data.modelId !== "string" || typeof data.summaryChars !== "number") continue;
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
        try { settings = memoryModelHandlers.get().settings; }
        catch (error) {
          stale = true;
          ctx.ui.notify(`Task memory configuration error: ${String(error)}`, "error");
          return;
        }
        if (!settings.enabled) { stale = true; return; }
        stale = true;
        try {
          ctx.ui.setStatus("task-memory", "Updating local task memory…");
          const run = await createLocalMemoryRunner({ signal: ctx.signal });
          // The completed turn is followed by a synthetic current request so the
          // source builder includes this turn; the sentinel itself is never stored.
          const effective = buildSessionContext(ctx.sessionManager.getBranch()).messages;
          const messages = [...effective, { role: "user", content: "", timestamp: Date.now() }];
          const next = await updateTaskMemory(messages, settings, run, current ?? null,
            (id: string, error: unknown) => ctx.ui.notify(
              `Task memory model ${id} failed; ${settings.fallback ? "trying configured backup" : "no backup is configured"}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            ));
          if (!next) return;
          current = next;
          stale = false;
          preview = {
            sourceHash: next.sourceHash,
            summary: next.summary,
            modelId: next.modelId,
            sourceChars: next.sourceChars,
            summaryChars: next.summaryChars,
          };
          pi.appendEntry(ENTRY_TYPE, { schemaVersion: 1, ...preview, createdAt: new Date().toISOString() });
          ctx.ui.setStatus("task-memory", `Memory: ${next.modelId} (${next.summaryChars} chars)`);
        } catch (error) {
          stale = true;
          ctx.ui.notify(`Local task memory update failed; no new summary was delivered: ${error instanceof Error ? error.message : String(error)}`, "error");
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
          await ctx.ui.confirm(`Local task memory (${preview.modelId}${stale ? ", stale — not sent" : ""})`,
            `Source: ${preview.sourceChars} characters. Summary: ${preview.summaryChars}/4000 characters.\n\n${preview.summary}`);
        },
      });
    },
  };
}
