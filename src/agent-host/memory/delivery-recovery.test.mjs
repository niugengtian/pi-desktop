import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMemoryDelivery } from "./delivery.mjs";
import { memoryCandidates } from "./tiers.mjs";
import { taskMemorySource } from "./task-memory.mjs";

const warning = "<!-- PAGE_PROVIDER_TURN_UNCONFIRMED -->\nWeb outcome unknown.";
const model = { id: "fixture", provider: "opencli-page", api: "opencli-page", contextWindow: 128000 };
const user = (content) => ({ role: "user", content });
const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: model.provider,
  model: model.id,
  stopReason,
});
const entriesOf = (messages) =>
  messages.map((message, index) => ({
    type: "message",
    id: `${index}`,
    parentId: index ? `${index - 1}` : null,
    timestamp: "2026-01-01T00:00:00Z",
    message,
  }));

test("failed turns exclude their user and tool sources, retaining only confirmed history", () => {
  const messages = [
    user("Confirmed goal"),
    assistant("Confirmed decision"),
    user("Unconfirmed request"),
    { role: "toolResult", content: "Unconfirmed tool finding" },
    assistant(warning),
    user("Next request"),
  ];
  const entries = entriesOf(messages);
  const projection = { entries: entries.map((sourceEntry) => ({ sourceEntry, messages: [sourceEntry.message] })) };
  assert.deepEqual(
    memoryCandidates(projection, { sessionId: "fixture", branchLeafId: "5" }).map((item) => item.text),
    ["Confirmed goal", "Confirmed decision", "Next request"],
  );
  const source = taskMemorySource(messages);
  assert.ok(source.includes("Confirmed decision"));
  assert.ok(!source.includes("Unconfirmed"));
  for (const reason of ["error", "aborted"]) {
    const failed = [user("Unconfirmed request"), assistant("Failure", reason), user("Next")];
    assert.equal(taskMemorySource(failed), "");
  }
});

test("approved Web retry carries recovery-only intent without replaying the warning", async () => {
  const messages = [user("Continue"), assistant(warning), user("Continue")];
  const entries = entriesOf(messages);
  let preview;
  const delivery = await prepareMemoryDelivery({
    model,
    context: { messages },
    from: null,
    estimatedTokens: null,
    entries,
    branchLeafId: "2",
    sessionId: "fixture",
    root: "/unused-fixture",
    ledger: null,
    approve: async (value) => {
      preview = value;
      return true;
    },
  });
  assert.equal(delivery.receipt.recoverOnly, true);
  assert.equal(preview.reason, "web-recovery-only");
  assert.ok(!preview.text.includes("PAGE_PROVIDER_TURN_UNCONFIRMED"));
  const fresh = await prepareMemoryDelivery({
    model,
    context: { messages: [user("Continue")] },
    from: null,
    estimatedTokens: null,
    entries: entriesOf([user("Continue")]),
    branchLeafId: "0",
    sessionId: "fixture",
    root: "/unused-fixture",
    ledger: null,
    approve: async () => true,
  });
  assert.equal(delivery.receipt.promptHash, fresh.receipt.promptHash);
  assert.equal(fresh.receipt.recoverOnly, false);
});

test("recursive historical handoffs are bounded after normalization, with original hashes retained", () => {
  const wrapper = `[PI TASK HANDOFF]\n${"Legacy state. ".repeat(600)}\n[/PI TASK HANDOFF]\n\n## Current request\nContinue`;
  const entries = entriesOf(Array.from({ length: 30 }, () => user(wrapper)));
  const projection = { entries: entries.map((sourceEntry) => ({ sourceEntry, messages: [sourceEntry.message] })) };
  const candidates = memoryCandidates(projection, { sessionId: "fixture", branchLeafId: "29" });
  assert.equal(candidates.length, 30);
  assert.ok(candidates.every((item) => item.text === "Continue" && /^[a-f0-9]{64}$/.test(item.sourceHash)));
});
