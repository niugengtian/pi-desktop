/** Move a native cut backwards, retaining complete tool batches in hot. No source is discarded. */
export function alignWarmToolBoundary(manager, preparation) {
  const entries = manager.buildSessionProjection().entries;
  let cut = entries.findIndex((row) => row.sourceEntry.id === preparation.firstKeptEntryId);
  if (cut < 0) throw new Error("WARM_CUT_NOT_FOUND");
  const previousIndex = entries.findIndex((row) => row.sourceEntry.type === "compaction" && row.messages.length);
  const start = previousIndex < 0 ? 0 : previousIndex + 1;
  const pending = new Map();
  for (let index = start; index < cut; index++) {
    for (const message of entries[index].messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) if (block.type === "toolCall") pending.set(block.id, index);
      }
      if (message.role === "toolResult") pending.delete(message.toolCallId);
    }
  }
  if (!pending.size) return preparation;
  cut = Math.min(...pending.values());
  if (cut <= start) throw new Error("WARM_NO_CLOSED_RANGE");
  const messages = entries
    .slice(start, cut)
    .flatMap((row) =>
      row.sourceEntry.type === "compaction" ? [] : row.messages.filter((message) => message.role !== "system"),
    );
  return {
    ...preparation,
    firstKeptEntryId: entries[cut].sourceEntry.id,
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    isSplitTurn: false,
  };
}
