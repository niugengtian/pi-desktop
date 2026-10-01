import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildTieredSnapshot, TieredWorkspace } from "./tiered-workspace.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-tiered-storage-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "native"));
  manager.appendMessage({ role: "user", content: "Fictional storage test", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Fictional" }],
    api: "openai-completions",
    provider: "fictional",
    model: "a",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 2,
  });
  const workspace = new TieredWorkspace(root, manager.getSessionId());
  return { root, manager, workspace, snapshot: buildTieredSnapshot(manager) };
}

test("source appended after snapshot is rejected before any generated view changes", (t) => {
  const f = fixture(t);
  f.workspace.sync(f.snapshot);
  const manifest = readFileSync(join(f.workspace.root, "workspace.json"));
  f.manager.appendMessage({ role: "user", content: "Newer fictional source", timestamp: 3 });
  assert.throws(() => f.workspace.sync(f.snapshot), /Late snapshot/);
  assert.deepEqual(readFileSync(join(f.workspace.root, "workspace.json")), manifest);
});

test("pre-existing future revision is never deleted; late staged relay leaves no false success", (t) => {
  const f = fixture(t);
  f.workspace.sync(f.snapshot);
  const future = join(f.workspace.root, ".revisions", "v2");
  mkdirSync(future, { mode: 0o700 });
  writeFileSync(join(future, "human.txt"), "Protected future revision", { mode: 0o600 });
  assert.throws(() => f.workspace.sync(f.snapshot), /EEXIST/);
  assert.equal(readFileSync(join(future, "human.txt"), "utf8"), "Protected future revision");
  rmSync(future, { recursive: true });
  let checks = 0;
  assert.throws(
    () =>
      f.workspace.sync(f.snapshot, {
        assertCurrent: () => ++checks === 1,
        target: { label: "fictional", provider: "fictional", modelId: "a" },
      }),
    /Late snapshot/,
  );
  assert.equal(f.workspace.state.relays.length, 0);
  assert.equal(existsSync(future), false);
  assert.equal(f.workspace.verify(), true);
});

test("partial initial export is rejected on reopen, not adopted as a completed generation", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace.root, "cool/history.jsonl"), "Partial crash residue", { mode: 0o600 });
  assert.throws(() => new TieredWorkspace(f.root, f.manager.getSessionId()), /Uncommitted/);
  assert.equal(readFileSync(join(f.workspace.root, "cool/history.jsonl"), "utf8"), "Partial crash residue");
});

test("prototype storage cap pauses before staging or publishing any view", (t) => {
  const f = fixture(t);
  const large = Buffer.alloc(8 * 1024 * 1024, 120);
  const oversized = {
    ...f.snapshot,
    files: Object.fromEntries(Object.keys(f.snapshot.files).map((path) => [path, large])),
  };
  const manifest = readFileSync(join(f.workspace.root, "workspace.json"));
  assert.throws(() => f.workspace.sync(oversized), /storage limit reached/);
  assert.deepEqual(readFileSync(join(f.workspace.root, "workspace.json")), manifest);
  assert.equal(existsSync(join(f.workspace.root, ".revisions/v1")), false);
  assert.equal(f.workspace.verify(), true);
});

test("generated workspace files are Git-ignored without changing project .gitignore", (t) => {
  const f = fixture(t);
  execFileSync("git", ["init", "--quiet", f.root]);
  writeFileSync(join(f.root, ".gitignore"), "human-rule\n");
  f.workspace.sync(f.snapshot);
  execFileSync("git", ["check-ignore", "--quiet", join(f.workspace.root, "cool/history.jsonl")], { cwd: f.root });
  execFileSync("git", ["check-ignore", "--quiet", join(f.workspace.root, "agents.md")], { cwd: f.root });
  assert.equal(readFileSync(join(f.root, ".gitignore"), "utf8"), "human-rule\n");
});
