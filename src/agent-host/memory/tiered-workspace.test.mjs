import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  lstatSync,
  symlinkSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildTieredSnapshot, TieredWorkspace, tieredHash } from "./tiered-workspace.mjs";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-tiered-fictional-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const manager = SessionManager.create(cwd, join(root, "native"));
  manager.appendModelChange("fictional-a", "a");
  manager.appendMessage({
    role: "system",
    content: "Fictional system only",
    toolsAdded: [{ name: "fictional_read", description: "Test", parameters: { type: "object", properties: {} } }],
    timestamp: 1,
  });
  const user = (content) => manager.appendMessage({ role: "user", content, timestamp: 2 });
  const assistant = (content = [{ type: "text", text: "Fictional acknowledgement" }], stopReason = "stop") =>
    manager.appendMessage({
      role: "assistant",
      content,
      stopReason,
      api: "openai-completions",
      provider: "fictional-a",
      model: "a",
      usage,
      timestamp: 3,
    });
  const olderId = user("Moon library order: Cloud Map, Paper Boat Diary, Starlight Recipes. Plan only.");
  assistant();
  const keptId = user("Captain Pine checks rope, counts three boxes, cleans deck; not yet completed.");
  assistant(
    [{ type: "toolCall", id: "fictional-call", name: "fictional_read", arguments: { file: "fiction.txt" } }],
    "toolUse",
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "fictional-call",
    toolName: "fictional_read",
    content: [{ type: "text", text: "Fictional source: rope unchecked." }],
    isError: false,
    timestamp: 4,
  });
  assistant();
  return { root, cwd, manager, user, assistant, olderId, keptId };
}

test("no compaction: full hot projection, no fabricated warm facts or token count", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.manager.getSessionFile());
  const snapshot = buildTieredSnapshot(f.manager);
  assert.equal(snapshot.warm.version, null);
  assert.equal(snapshot.files["warm/facts.jsonl"], "");
  assert.deepEqual(snapshot.projectedContext, f.manager.buildSessionProjection().messages);
  assert.equal(snapshot.hot.length, 6);
  assert.deepEqual(snapshot.pendingToolCallIds, []);
  assert.deepEqual(snapshot.files["cool/history.jsonl"], before);
  const workspace = new TieredWorkspace(f.cwd, f.manager.getSessionId());
  workspace.sync(snapshot);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), before);
  assert.match(readFileSync(join(workspace.root, "hot/manifest.json"), "utf8"), /not-measured/);
});

test("native compaction is the sole warm owner; A-B-A switching retains one summary and exact tool chain", (t) => {
  const f = fixture(t);
  const compactionId = f.manager.appendCompaction(
    "Moon library: Cloud Map → Paper Boat Diary → Starlight Recipes. Plan, not completed.",
    f.keptId,
    100,
  );
  const initial = buildTieredSnapshot(f.manager);
  const workspace = new TieredWorkspace(f.cwd, f.manager.getSessionId());
  workspace.sync(initial);
  for (const [provider, modelId] of [
    ["fictional-b", "b"],
    ["fictional-a", "a"],
  ]) {
    f.manager.appendModelChange(provider, modelId);
    const snapshot = buildTieredSnapshot(f.manager);
    const result = workspace.sync(snapshot, { target: { label: provider, provider, modelId } });
    assert.equal(snapshot.warm.version, compactionId);
    assert.deepEqual(snapshot.projectedContext, initial.projectedContext);
    assert.equal(snapshot.projectedContext.filter((m) => m.role === "compactionSummary").length, 1);
    assert.equal(
      snapshot.hot.some((r) => r.sourceEntryId === f.olderId),
      false,
    );
    assert.ok(snapshot.warm.sourceEntryIds.includes(f.olderId));
    assert.equal(snapshot.hot.filter((r) => r.message.role === "toolResult").length, 1);
    assert.match(result.relay, /_session-/);
    assert.equal(
      JSON.parse(readFileSync(join(workspace.root, result.relay, "binding.json"))).status,
      "pending-not-sent",
    );
    assert.equal(readdirSync(join(workspace.root, result.relay)).includes("sent-context.json"), false);
    assert.equal(workspace.verify(), true);
  }
  assert.equal(workspace.state.relays.length, 2);
  assert.equal(new TieredWorkspace(f.cwd, f.manager.getSessionId()).verify(), true);
});

test("uncovered increment and unfinished tool calls stay hot; context edits and branch selection follow SDK", (t) => {
  const f = fixture(t);
  f.manager.appendCompaction("Fictional earlier plan", f.keptId, 100);
  const newId = f.user("Uncovered increment: keep exact number 17.");
  const pendingId = f.assistant(
    [{ type: "toolCall", id: "pending-17", name: "fictional_read", arguments: { file: "17.txt" } }],
    "toolUse",
  );
  let snapshot = buildTieredSnapshot(f.manager);
  assert.ok(snapshot.hot.some((r) => r.sourceEntryId === newId));
  assert.deepEqual(snapshot.pendingToolCallIds, ["pending-17"]);
  f.manager.appendContextEdit(newId, { content: "Edited fictional fact: 19." });
  snapshot = buildTieredSnapshot(f.manager);
  assert.equal(snapshot.hot.find((r) => r.sourceEntryId === newId).message.content, "Edited fictional fact: 19.");
  assert.match(snapshot.files["cool/history.jsonl"].toString(), /number 17/);
  f.manager.branch(f.keptId);
  snapshot = buildTieredSnapshot(f.manager);
  assert.equal(snapshot.warm.version, null);
  assert.equal(
    snapshot.hot.some((r) => r.sourceEntryId === pendingId),
    false,
  );
});

test("human-edited generated files stop export; human-owned agents.md is preserved", (t) => {
  const f = fixture(t);
  const workspace = new TieredWorkspace(f.cwd, f.manager.getSessionId());
  const snapshot = buildTieredSnapshot(f.manager);
  workspace.sync(snapshot);
  const agents = join(workspace.root, "agents.md");
  writeFileSync(agents, "Human rule; do not rewrite.");
  workspace.sync(snapshot);
  assert.equal(readFileSync(agents, "utf8"), "Human rule; do not rewrite.");
  const handoff = join(workspace.root, "handoff.md");
  writeFileSync(handoff, "Human rescue text");
  const manifestBefore = readFileSync(join(workspace.root, "workspace.json"));
  assert.throws(() => workspace.sync(snapshot), /Human edit protected/);
  assert.deepEqual(readFileSync(join(workspace.root, "workspace.json")), manifestBefore);
  assert.equal(readFileSync(handoff, "utf8"), "Human rescue text");
});

test("symlink, permissive chmod and path traversal fail closed without touching external files", (t) => {
  const f = fixture(t);
  const workspace = new TieredWorkspace(f.cwd, f.manager.getSessionId());
  const snapshot = buildTieredSnapshot(f.manager);
  workspace.sync(snapshot);
  const external = join(f.root, "outside");
  writeFileSync(external, "unchanged");
  const handoff = join(workspace.root, "handoff.md");
  rmSync(handoff);
  symlinkSync(external, handoff);
  assert.throws(() => workspace.sync(snapshot), /Unsafe/);
  assert.equal(readFileSync(external, "utf8"), "unchanged");
  assert.throws(() => new TieredWorkspace(f.cwd, "../escape"), /Unsafe workspace identifier/);
  rmSync(handoff);
  writeFileSync(handoff, snapshot.handoff, { mode: 0o600 });
  chmodSync(handoff, 0o644);
  assert.throws(() => workspace.sync(snapshot), /permissions changed/);
});

test("late source, concurrent writer and changed manifest never advance committed state", (t) => {
  const f = fixture(t);
  const workspace = new TieredWorkspace(f.cwd, f.manager.getSessionId());
  const snapshot = buildTieredSnapshot(f.manager);
  workspace.sync(snapshot);
  const manifest = readFileSync(join(workspace.root, "workspace.json"));
  assert.throws(() => workspace.sync(snapshot, { assertCurrent: () => false }), /Late snapshot/);
  mkdirSync(join(workspace.root, ".write-lock"));
  assert.throws(() => workspace.sync(snapshot), /EEXIST/);
  rmSync(join(workspace.root, ".write-lock"), { recursive: true });
  assert.deepEqual(readFileSync(join(workspace.root, "workspace.json")), manifest);
  writeFileSync(join(workspace.root, "workspace.json"), "{}", { mode: 0o600 });
  assert.throws(() => workspace.sync(snapshot), /manifest was edited/);
});

test("private permissions and deterministic handoff; source mismatch is rejected", (t) => {
  const f = fixture(t);
  const workspace = new TieredWorkspace(f.cwd, f.manager.getSessionId());
  const snapshot = buildTieredSnapshot(f.manager);
  workspace.sync(snapshot);
  assert.equal(lstatSync(workspace.root).mode & 0o777, 0o700);
  for (const path of Object.keys(snapshot.files))
    assert.equal(lstatSync(join(workspace.root, path)).mode & 0o777, 0o600);
  assert.equal(snapshot.handoff, buildTieredSnapshot(f.manager).handoff);
  const native = f.manager.getSessionFile();
  const original = readFileSync(native);
  writeFileSync(native, `${original}{"type":"custom","id":"alien"}\n`);
  assert.throws(() => buildTieredSnapshot(f.manager), /differ/);
  assert.equal(tieredHash(readFileSync(join(workspace.root, "cool/history.jsonl"))), tieredHash(original));
});
