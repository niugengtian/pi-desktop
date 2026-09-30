import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  memoryRecordId,
  openMemoryMarkdown,
  renderMemoryMarkdown,
  searchMemoryMarkdown,
  writeMemoryMarkdown,
} from "./markdown-store.mjs";

const source = {
  sessionId: "fictional-session",
  branchLeafId: "leaf-a",
  entryId: "entry-1",
  sourceHash: "a".repeat(64),
};
const record = (summary = "## 目标\n完成可读记忆。") => ({
  id: memoryRecordId("fictional-session", ["entry-1"]),
  tier: "warm",
  title: "记忆与检索设计",
  summary,
  sources: [source],
  updatedAt: "2026-01-02T03:04:05Z",
  modelId: "local/qwen",
  keywords: ["本地检索", "决定"],
});

test("Obsidian-readable Markdown with complete provenance, keyword search then explicit open", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-memory-vault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = writeMemoryMarkdown(root, record());
  assert.match(created.path, /^warm\/mem-[a-f0-9]{24}\.md$/);
  const text = readFileSync(path.join(root, created.path), "utf8");
  for (const value of ["# 记忆与检索设计", "## Sources", "fictional-session", "leaf-a", "entry-1", source.sourceHash])
    assert.ok(text.includes(value));
  const hits = searchMemoryMarkdown(root, "本地检索");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "记忆与检索设计");
  assert.ok(!JSON.stringify(hits).includes("完成可读记忆"));
  assert.equal(openMemoryMarkdown(root, hits[0]), text);
});

test("human edit is never overwritten; stale search cannot silently open changed content", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-memory-vault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = writeMemoryMarkdown(root, record());
  const hit = searchMemoryMarkdown(root, "记忆")[0];
  const file = path.join(root, saved.path);
  writeFileSync(file, readFileSync(file, "utf8") + "\n人工补充：不要覆盖。\n");
  assert.throws(() => writeMemoryMarkdown(root, record("新摘要"), saved.hash), /manual edits were preserved/);
  assert.throws(() => openMemoryMarkdown(root, hit), /search again/);
  assert.match(readFileSync(file, "utf8"), /人工补充/);
  assert.throws(() => writeMemoryMarkdown(root, record("新摘要")), /lacks an expected revision/);
});

test("updates need the exact revision; new records are never created as updates", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-memory-vault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => writeMemoryMarkdown(root, record(), "a".repeat(64)), /removed/);
  const saved = writeMemoryMarkdown(root, record());
  assert.equal(writeMemoryMarkdown(root, record(), saved.hash).unchanged, true);
  const updated = writeMemoryMarkdown(root, record("新的阶段摘要"), saved.hash);
  assert.notEqual(updated.hash, saved.hash);
  assert.match(openMemoryMarkdown(root, searchMemoryMarkdown(root, "阶段摘要")[0]), /新的阶段摘要/);
});

test("rejects traversal, forged YAML values and missing provenance", () => {
  assert.throws(() => renderMemoryMarkdown({ ...record(), id: "../outside" }), /Invalid memory record ID/);
  assert.throws(() => renderMemoryMarkdown({ ...record(), tier: "cold" }), /Only hot and warm/);
  assert.throws(() => renderMemoryMarkdown({ ...record(), sources: [] }), /sources/);
  const markdown = renderMemoryMarkdown({ ...record(), modelId: "model\ninjected: true" });
  assert.ok(!markdown.includes("\ninjected: true"));
});
