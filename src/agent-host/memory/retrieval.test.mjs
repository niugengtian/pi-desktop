import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchColdMemory, openColdMemory } from "./cold-store.mjs";
import { searchIndexedMemory } from "./qmd.mjs";
import { writeMemoryMarkdown } from "./markdown-store.mjs";

test("cold search opens only the selected Pi ancestor branch and detects a changed entry", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cold-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "fictional-cold", cwd: dir, timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "cold design" } },
    {
      type: "message",
      id: "a",
      parentId: "u",
      message: { role: "assistant", content: [{ type: "text", text: "cold decision" }], stopReason: "stop" },
    },
    {
      type: "message",
      id: "orphan",
      parentId: "u",
      message: { role: "assistant", content: [{ type: "text", text: "cold abandoned secret" }], stopReason: "stop" },
    },
  ];
  const save = () => writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  save();
  const results = searchColdMemory(file, "cold", { branchLeafId: "a" });
  assert.deepEqual(results.map((r) => r.entryId).sort(), ["a", "u"]);
  const selected = results.find((r) => r.entryId === "a");
  assert.equal(openColdMemory(selected).id, "a");
  entries[2].message.content[0].text = "revised cold source";
  save();
  assert.throws(() => openColdMemory(selected), /changed/);
});

function record() {
  return {
    id: "mem-" + "a".repeat(24),
    tier: "warm",
    title: "Index fixture",
    summary: "Offline retrieval",
    updatedAt: "2026-01-01T00:00:00Z",
    sources: [{ sessionId: "fixture", branchLeafId: "a", entryId: "a", sourceHash: "b".repeat(64) }],
  };
}
test("QMD SDK contract uses isolated inline config/BM25 and opens the real Markdown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qmd-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = writeMemoryMarkdown(dir, record());
  let closed = false;
  const result = await searchIndexedMemory(dir, "Offline", {
    modulePath: "/fixture/qmd/index.js",
    load: async () => ({
      createStore: async (options) => {
        assert.equal(options.dbPath, join(dir, ".index", "qmd.sqlite"));
        assert.deepEqual(Object.keys(options.config.collections), ["pi-hot", "pi-warm"]);
        return {
          update: async () => {},
          searchLex: async () => [{ file: `qmd://pi-warm/${record().id}.md`, score: 0.9 }],
          close: async () => {
            closed = true;
          },
        };
      },
    }),
  });
  assert.equal(closed, true);
  assert.equal(result.backend, "qmd-bm25");
  assert.equal(result.results[0].hash, saved.hash);
});

test("a dangling SQLite symlink is refused before loading the SDK", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qmd-symlink-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeMemoryMarkdown(dir, record());
  mkdirSync(join(dir, ".index"));
  symlinkSync(join(dir, "outside.sqlite"), join(dir, ".index", "qmd.sqlite"));
  let loaded = false;
  const result = await searchIndexedMemory(dir, "Offline", {
    modulePath: "/fixture/qmd/index.js",
    load: async () => {
      loaded = true;
      throw Error("must not load");
    },
  });
  assert.equal(loaded, false);
  assert.equal(result.backend, "keyword");
  assert.match(result.warning, /regular file/);
});

test("bad QMD paths fall back locally; tier-directory symlinks are refused", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qmd-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeMemoryMarkdown(dir, record());
  const result = await searchIndexedMemory(dir, "Offline", {
    modulePath: "/fixture/qmd/index.js",
    load: async () => ({
      createStore: async () => ({
        update: async () => {},
        searchLex: async () => [{ file: "qmd://other/private.md", score: 1 }],
        close: async () => {},
      }),
    }),
  });
  assert.equal(result.backend, "keyword");
  assert.equal(result.results.length, 1);
  assert.match(result.warning, /out-of-vault/);
  const outside = join(dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(dir, "hot"));
  await assert.rejects(searchIndexedMemory(dir, "Offline"), /symlink/);
});
