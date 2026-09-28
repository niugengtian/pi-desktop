import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedSummary,
  buildIncrementalHandoff,
  checkpointFrom,
  consumeHandoffAcknowledgement,
  createCheckpoint,
  planConversationRoute,
  sha256Text,
  shouldDedupeRetry,
  verifiedOutcomeSummary,
} from "../src/continuity.mjs";

function checkpoint(sequence, modelId = "deepseek-chat") {
  return createCheckpoint({
    taskId: "task-1",
    sequence,
    transcriptEntryId: `entry-${sequence}`,
    modelId,
    userText: `request ${sequence}`,
    assistantText: `outcome ${sequence}`,
    createdAt: `2026-09-24T00:00:0${sequence}.000Z`,
  });
}

test("createCheckpoint stores bounded summaries and hashes instead of full bodies", () => {
  const request = `start ${"x".repeat(2_000)}`;
  const outcome = `done ${"y".repeat(4_000)}`;
  const value = createCheckpoint({
    taskId: "task-1",
    sequence: 1,
    transcriptEntryId: "entry-1",
    modelId: "deepseek-chat",
    userText: request,
    assistantText: outcome,
    createdAt: "2026-09-24T00:00:00.000Z",
  });

  assert.equal(value.inputHash, sha256Text(request));
  assert.equal(value.outputHash, sha256Text(outcome));
  assert.ok(value.requestSummary.length <= 600);
  assert.ok(value.outcomeSummary.length <= 1_200);
  assert.equal(checkpointFrom(value), value);
  assert.equal(checkpointFrom({ ...value, sequence: 0 }), undefined);
});

test("conversation routing isolates new tasks, resumes bindings, and preserves failed retries", () => {
  assert.deepEqual(planConversationRoute(undefined, false), {
    conversationId: undefined,
    newConversation: true,
  });
  assert.deepEqual(planConversationRoute("remote-1", false), {
    conversationId: "remote-1",
    newConversation: false,
  });
  assert.deepEqual(planConversationRoute(undefined, true), {
    conversationId: undefined,
    newConversation: false,
  });
  assert.deepEqual(planConversationRoute("remote-1", true), {
    conversationId: "remote-1",
    newConversation: false,
  });
});

test("retry deduplication is enabled only after a matching failed turn", () => {
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
  const failed = { role: "assistant", stopReason: "error", content: [] };
  const aborted = { role: "assistant", stopReason: "aborted", content: [] };
  const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
  const sentUnconfirmed = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "<!-- PAGE_PROVIDER_TURN_UNCONFIRMED -->\nnot automatically retried" }],
  };

  assert.equal(shouldDedupeRetry([user("same"), failed], "same"), true);
  assert.equal(shouldDedupeRetry([user("same"), aborted], "same"), true);
  assert.equal(shouldDedupeRetry([user("same"), sentUnconfirmed], "same"), true);
  assert.equal(shouldDedupeRetry([user("same"), failed, user("same")], "same"), true);
  assert.equal(shouldDedupeRetry([user("same"), success, user("same")], "same"), false);
  assert.equal(shouldDedupeRetry([user("other"), failed, user("same")], "same"), false);
});

test("handoffs do not treat unexecuted web-model tool markup as completed progress", () => {
  const fakeAction = '<｜｜DSML｜｜ invoke name="bash">git push</｜｜DSML｜｜ invoke>';
  assert.match(verifiedOutcomeSummary(fakeAction), /Unverified action markup omitted/);
  assert.equal(verifiedOutcomeSummary("A verified textual conclusion"), "A verified textual conclusion");

  const unsafe = checkpoint(1);
  unsafe.outcomeSummary = `I completed it.\n${fakeAction}`;
  const bundle = buildIncrementalHandoff({
    taskId: "task-1",
    targetModelId: "chatgpt-web",
    checkpoints: [unsafe],
    currentRequest: "continue",
  });
  assert.doesNotMatch(bundle.text, /git push|I completed it/);
  assert.match(bundle.text, /PI did not execute it/);
});

test("buildIncrementalHandoff sends only checkpoints after the target cursor", () => {
  const bundle = buildIncrementalHandoff({
    taskId: "task-1",
    targetModelId: "chatgpt-web",
    checkpoints: [checkpoint(1), checkpoint(2), checkpoint(3)],
    lastSyncedCheckpoint: 1,
    currentRequest: "continue with the next step",
  });

  assert.equal(bundle.fromCheckpoint, 2);
  assert.equal(bundle.throughCheckpoint, 3);
  assert.equal(bundle.checkpointCount, 2);
  assert.doesNotMatch(bundle.text, /request 1/);
  assert.match(bundle.text, /request 2/);
  assert.match(bundle.text, /request 3/);
  assert.match(bundle.text, /Current request\ncontinue with the next step/);
  assert.match(bundle.text, /PI_HANDOFF_ACK task=task-1 checkpoint=3/);
});

test("buildIncrementalHandoff is absent when the target is current", () => {
  assert.equal(
    buildIncrementalHandoff({
      taskId: "task-1",
      targetModelId: "chatgpt-web",
      checkpoints: [checkpoint(1)],
      lastSyncedCheckpoint: 1,
      currentRequest: "next",
    }),
    undefined,
  );
});

test("handoff is tail-bounded and reports omitted checkpoints", () => {
  const checkpoints = Array.from({ length: 8 }, (_, index) => ({
    ...checkpoint(index + 1),
    outcomeSummary: boundedSummary(`result ${index + 1} ${"z".repeat(300)}`),
  }));
  const bundle = buildIncrementalHandoff({
    taskId: "task-1",
    targetModelId: "chatgpt-web",
    checkpoints,
    lastSyncedCheckpoint: 0,
    currentRequest: "next",
    maxChars: 1_000,
  });

  assert.ok(bundle.text.length <= 1_050);
  assert.ok(bundle.includedCheckpointCount < bundle.checkpointCount);
  assert.match(bundle.text, /were omitted by the handoff size bound/);
  assert.match(bundle.text, /Checkpoint 8/);
});

test("consumeHandoffAcknowledgement validates and removes only the expected marker", () => {
  const success = consumeHandoffAcknowledgement(
    "PI_HANDOFF_ACK task=task-1 checkpoint=3\n\nWork continues.",
    "task-1",
    3,
  );
  assert.deepEqual(success, {
    acknowledged: true,
    markdown: "Work continues.",
    acknowledgement: "PI_HANDOFF_ACK task=task-1 checkpoint=3",
  });

  const escaped = consumeHandoffAcknowledgement(
    "PI\\_HANDOFF\\_ACK task=task-1 checkpoint=3\nWork continues.",
    "task-1",
    3,
  );
  assert.equal(escaped.acknowledged, true);
  assert.equal(escaped.markdown, "Work continues.");

  const wrong = consumeHandoffAcknowledgement("PI_HANDOFF_ACK task=other checkpoint=3\nWork continues.", "task-1", 3);
  assert.equal(wrong.acknowledged, false);
});
