import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { memoryCandidates, memoryCursor, splitMemoryTiers } from "./tiers.mjs";
import { memoryRecordId, writeMemoryMarkdown } from "./markdown-store.mjs";
import { taskMemorySource, updateTaskMemory } from "./task-memory.mjs";
import { openMemoryMarkdown } from "./markdown-store.mjs";

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
  checkpoint = null,
  expectedHash = null,
  onFailure = () => {},
  hotChars = 12_000,
}) {
  if (!Array.isArray(entries) || !branchLeafId || !sessionId || !root)
    throw new Error("Session, branch and local vault are required.");
  if (settings.enabled === false) return null;
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
  // Summarize only eligible projected candidate text. Re-expanding an entry
  // could accidentally reintroduce a failed/unconfirmed sibling message.
  const toMessage = (item) => ({ role: item.role, content: item.text });
  const messages = staged.map(toMessage);
  messages.push({ role: "user", content: "", timestamp: Date.now() });
  const cursor = memoryCursor(staged, checkpoint?.tier === tier ? checkpoint.cursor : null);
  const branchCursor = memoryCursor(candidates);
  // Restore an incremental source from this verified branch, not another raw
  // transcript copy in the ledger. A changed prefix is always a fresh compile.
  if (checkpoint?.tier === tier && cursor.appended !== null) {
    const prefixCount = checkpoint.cursor.entries.length;
    const prefixMessages = staged.slice(0, prefixCount).map(toMessage);
    prefixMessages.push({ role: "user", content: "", timestamp: 0 });
    previous = { ...checkpoint.memory, source: taskMemorySource(prefixMessages) };
    // Check the persisted revision even when no model call is necessary.
    try {
      openMemoryMarkdown(root, { id: checkpoint.id, tier, hash: checkpoint.hash });
    } catch (error) {
      throw new Error("Memory checkpoint changed; manual edits were preserved.", { cause: error });
    }
  }
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
  const saved =
    cursor.unchanged && checkpoint?.id === id
      ? { path: checkpoint.path, hash: checkpoint.hash, unchanged: true }
      : writeMemoryMarkdown(root, record, expectedHash);
  return {
    // Persist only source IDs/hashes. The transient cursor.appended contains
    // candidate text and must never create a second raw transcript in JSONL.
    cursor: { fingerprint: cursor.fingerprint, entries: cursor.entries },
    branchCursor: { fingerprint: branchCursor.fingerprint, entries: branchCursor.entries },
    ...saved,
    record,
    memory,
    hotChars: hot.reduce((n, item) => n + item.text.length, 0),
    warmCount: warmCandidates.length,
  };
}
