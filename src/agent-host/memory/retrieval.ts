import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchIndexedMemory } from "./qmd.mjs";
import { openMemoryMarkdown } from "./markdown-store.mjs";
import { searchColdMemory, openColdMemory } from "./cold-store.mjs";

export function registerMemoryRetrieval(pi: ExtensionAPI, root: string) {
  pi.registerCommand("task-memory-search", {
    description: "Search/open local Markdown memory; use 'cold QUERY' for this session's JSONL sources",
    handler: async (args, ctx) => {
      try {
        if (!ctx.hasUI) throw new Error("Memory retrieval requires a supported UI.");
        const cold = args.startsWith("cold ");
        const query = cold ? args.slice(5).trim() : args.trim();
        if (cold) {
          const file = ctx.sessionManager.getSessionFile();
          const leaf = ctx.sessionManager.getLeafId();
          if (!file || !leaf) throw new Error("No persisted session source is available.");
          const results = searchColdMemory(file, query, { branchLeafId: leaf });
          const labels = results.map((hit, index) => `${index + 1}. ${hit.title}`);
          const chosen = await ctx.ui.select("Local cold sources (never shared automatically)", labels);
          const index = labels.indexOf(chosen ?? "");
          if (index >= 0) {
            const entry = openColdMemory(results[index]);
            const text = JSON.stringify(entry, null, 2);
            if (text.length > 60_000) throw new Error("Source too large for the preview; inspect the JSONL locally.");
            await ctx.ui.confirm("Local source entry", text);
          }
        } else {
          const searched = await searchIndexedMemory(root, query);
          if (searched.warning) ctx.ui.notify(searched.warning, "warning");
          const labels = searched.results.map((hit, index) => `${index + 1}. ${hit.title} · ${hit.path}`);
          const chosen = await ctx.ui.select(`Local memory (${searched.backend})`, labels);
          const index = labels.indexOf(chosen ?? "");
          if (index >= 0)
            await ctx.ui.confirm(
              join(root, searched.results[index].path),
              openMemoryMarkdown(root, searched.results[index]),
            );
        }
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
