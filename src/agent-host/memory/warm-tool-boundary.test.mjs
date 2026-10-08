import test from "node:test";
import assert from "node:assert/strict";
import { alignWarmToolBoundary } from "./warm-tool-boundary.mjs";

test("warm cut retains the entire unfinished tool batch in hot", () => {
  const entries = [
    { sourceEntry: { id: "old" }, messages: [{ role: "user", content: "old fact" }] },
    { sourceEntry: { id: "call" }, messages: [{ role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] }] },
    { sourceEntry: { id: "result" }, messages: [{ role: "toolResult", toolCallId: "tool-1", content: [] }] },
    { sourceEntry: { id: "new" }, messages: [{ role: "user", content: "new" }] },
  ];
  const manager = { buildSessionProjection: () => ({ entries }) };
  const preparation = {
    firstKeptEntryId: "result",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: true,
  };
  const fixed = alignWarmToolBoundary(manager, preparation);
  assert.equal(fixed.firstKeptEntryId, "call");
  assert.deepEqual(fixed.messagesToSummarize, entries[0].messages);
  assert.equal(preparation.firstKeptEntryId, "result");
  const closed = { ...preparation, firstKeptEntryId: "new" };
  assert.equal(alignWarmToolBoundary(manager, closed), closed);
});
