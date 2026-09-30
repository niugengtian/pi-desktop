import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { memoryCandidates, memoryCursor, planMemoryDelivery, splitMemoryTiers } from "./tiers.mjs";

const entry = (id, parentId, role, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message:
    role === "assistant"
      ? { role, content: [{ type: "text", text }], stopReason: "stop", provider: "fixture", model: "fixture" }
      : { role, content: text, timestamp: Date.now() },
});
const project = (entries, leafId) =>
  memoryCandidates(buildSessionProjection(entries, leafId), { sessionId: "fictional-session", branchLeafId: leafId });

test("forks, context edits, and compaction respect Pi's projected current branch", () => {
  const root = entry("root", null, "user", "Keep this goal");
  const original = entry("old", "root", "assistant", "Discarded branch secret");
  const fork = entry("fork", "root", "assistant", "Active branch decision");
  const edited = {
    type: "context_edit",
    id: "edit",
    parentId: "fork",
    targetId: "root",
    replacement: { content: "Updated goal" },
    timestamp: "2026-01-01T00:00:01.000Z",
  };
  const before = project([root, original, fork, edited], "edit");
  assert.deepEqual(
    before.map(({ text }) => text),
    ["Updated goal", "Active branch decision"],
  );
  assert.ok(!before.some(({ text }) => text.includes("secret")));

  const checkpoint = {
    type: "compaction",
    id: "compact",
    parentId: "edit",
    firstKeptEntryId: "fork",
    summary: "Earlier goal checkpoint",
    tokensBefore: 1000,
    timestamp: "2026-01-01T00:00:02.000Z",
  };
  const latest = entry("latest", "compact", "user", "Next stage");
  const after = project([root, original, fork, edited, checkpoint, latest], "latest");
  assert.deepEqual(
    after.map(({ text }) => text),
    ["Earlier goal checkpoint", "Active branch decision", "Next stage"],
  );
  assert.deepEqual(
    after.map(({ entryId }) => entryId),
    ["compact", "fork", "latest"],
  );
});

test("hot suffix never truncates a record; warm retains exact source pointers", () => {
  const candidates = project(
    [entry("a", null, "user", "old-1"), entry("b", "a", "user", "old-2"), entry("c", "b", "user", "now")],
    "c",
  );
  const result = splitMemoryTiers(candidates, { hotChars: 4 });
  assert.deepEqual(
    result.hot.map(({ entryId }) => entryId),
    ["c"],
  );
  assert.deepEqual(
    result.warmCandidates.map(({ entryId }) => entryId),
    ["a", "b"],
  );
  assert.equal(result.warmCandidates[0].sessionId, "fictional-session");
  assert.equal(result.warmCandidates[0].text, "old-1");
});

test("cursor advances only on an unchanged prefix, never across edited branches", () => {
  const first = project([entry("a", null, "user", "goal")], "a");
  const state = memoryCursor(first);
  assert.equal(memoryCursor(first, state).unchanged, true);
  const extended = project([entry("a", null, "user", "goal"), entry("b", "a", "user", "new")], "b");
  assert.deepEqual(
    memoryCursor(extended, state).appended.map(({ entryId }) => entryId),
    ["b"],
  );
  assert.equal(memoryCursor(project([entry("a", null, "user", "changed")], "a"), state).appended, null);
});

test("normal only for same provider and model under known budget; otherwise stage", () => {
  const same = { provider: "api", modelId: "model-a" };
  const base = { from: same, to: same, estimatedTokens: 100, contextWindow: 1000 };
  assert.equal(planMemoryDelivery(base).mode, "normal");
  assert.equal(planMemoryDelivery({ ...base, to: { ...same, modelId: "model-b" } }).mode, "staged");
  assert.equal(planMemoryDelivery({ ...base, to: { provider: "web", modelId: "model-a" } }).mode, "staged");
  assert.equal(planMemoryDelivery({ ...base, estimatedTokens: 800 }).mode, "staged");
  assert.equal(planMemoryDelivery({ ...base, estimatedTokens: null }).mode, "staged");
});
