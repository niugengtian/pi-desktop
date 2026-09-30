import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { memoryCandidates, splitMemoryTiers } from "./tiers.mjs";
import { memoryRecordId, writeMemoryMarkdown } from "./markdown-store.mjs";
import { updateTaskMemory } from "./task-memory.mjs";

/**
 * Compile the active Pi branch into a human-readable stage file. This is a
 * local write only: the returned Markdown is never inserted into provider context.
 * Callers retain the returned revision to avoid overwriting human edits.
 */
export async function compileTaskMemory({
  entries,
  branchLeafId,
  sessionId,
  settings,
  run,
  root,
  previous = null,
  expectedHash = null,
  onFailure = () => {},
  hotChars = 12_000,
  signal,
  commit,
}) {
  if (!Array.isArray(entries) || !branchLeafId || !sessionId || !root)
    throw new Error("Session, branch and local vault are required.");
  if (settings.enabled === false) return null;
  signal?.throwIfAborted();
  const projection = buildSessionProjection(entries, branchLeafId);
  const candidates = memoryCandidates(projection, { sessionId, branchLeafId });
  // Exclude the pending user request, if any. Completed assistant turns may be
  // compiled; an uncompleted user request cannot become a confirmed decision.
  if (candidates.at(-1)?.role === "user") candidates.pop();
  if (candidates.length === 0) return null;
  const { hot, warmCandidates } = splitMemoryTiers(candidates, { hotChars });
  const staged = warmCandidates.length > 0 ? warmCandidates : hot;
  const tier = warmCandidates.length > 0 ? "warm" : "hot";
  const id = memoryRecordId(
    sessionId,
    staged.map((candidate) => candidate.entryId),
  );
  const selectedIds = new Set(staged.map((candidate) => candidate.entryId));
  const selected = projection.entries.filter((item) => selectedIds.has(item.sourceEntry.id));
  // The summarizer sees only the selected projected messages, never raw JSONL,
  // system declarations, or unrelated branches.
  const messages = selected.flatMap((item) => item.messages).filter((message) => message.role !== "system");
  messages.push({ role: "user", content: "", timestamp: Date.now() });
  const memory = await updateTaskMemory(messages, settings, run, previous, onFailure);
  if (!memory) return null;
  const record = {
    id,
    tier,
    title: `Task memory · ${sessionId.slice(0, 12)}`,
    summary: memory.summary,
    modelId: memory.modelId,
    updatedAt: new Date().toISOString(),
    keywords: [],
    sources: staged.map(({ sessionId: sourceSession, branchLeafId: sourceBranch, entryId, sourceHash }) => ({
      sessionId: sourceSession,
      branchLeafId: sourceBranch,
      entryId,
      sourceHash,
    })),
  };
  // A different stage/branch gets a new file, never the previous file's
  // revision. An existing target still requires its own known revision.
  signal?.throwIfAborted();
  // A background caller may validate and append its ledger in the same
  // synchronous commit that writes Markdown, without reusing a stale context.
  const saved = commit ? commit(record, memory) : writeMemoryMarkdown(root, record, expectedHash);
  return {
    ...saved,
    record,
    memory,
    hotChars: hot.reduce((n, item) => n + item.text.length, 0),
    warmCount: warmCandidates.length,
  };
}
