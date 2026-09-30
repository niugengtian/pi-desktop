import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileTaskMemory } from "./compile.mjs";
import { openMemoryMarkdown, searchMemoryMarkdown } from "./markdown-store.mjs";

const entry = (id, parentId, role, content) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00Z",
  message:
    role === "assistant"
      ? { role, content: [{ type: "text", text: content }], stopReason: "stop", provider: "api", model: "fixture" }
      : { role, content, timestamp: Date.now() },
});
const rootEntry = entry("goal", null, "user", "Design an offline memory system");
const answer = entry("decision", "goal", "assistant", "Decision: local model summarizes confirmed turns");
const abandoned = entry("abandoned", "goal", "assistant", "Secret abandoned branch");
const active = entry("active", "decision", "user", "Next task: add a Markdown vault");
const completed = entry("result", "active", "assistant", "Result: Markdown format and provenance verified");
const entries = [rootEntry, answer, abandoned, active, completed];
const settings = { enabled: true, primary: "local/qwen", fallback: null };

function fixture(root, extra = {}) {
  return {
    entries,
    branchLeafId: "result",
    sessionId: "fictional-session",
    settings,
    root,
    run: async () => "目标：可读记忆。\n决策：使用本地模型。\n进度：Markdown 与来源核对完成。",
    ...extra,
  };
}

test("fictional Pi branch → local model → warm Markdown → search/open", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-compile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let prompt;
  const result = await compileTaskMemory(
    fixture(root, {
      hotChars: 45,
      run: async (_id, text) => {
        prompt = text;
        return "目标：可读记忆。\n决策：使用本地模型。\n进度：Markdown 与来源核对完成。";
      },
    }),
  );
  assert.equal(result.record.tier, "warm");
  assert.ok(result.warmCount > 0);
  assert.ok(!prompt.includes("Secret abandoned branch"));
  assert.ok(prompt.includes("Decision: local model summarizes confirmed turns"));
  const text = readFileSync(path.join(root, result.path), "utf8");
  assert.match(text, /进度：Markdown 与来源核对完成/);
  assert.match(text, /fictional-session/);
  assert.ok(!text.includes("Secret abandoned branch"));
  const hits = searchMemoryMarkdown(root, "可读记忆");
  assert.equal(hits.length, 1);
  assert.equal(openMemoryMarkdown(root, hits[0]), text);
});

test("failed local model writes nothing; manual edits block a later model update", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-compile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    compileTaskMemory(
      fixture(root, {
        run: async () => {
          throw Error("offline");
        },
      }),
    ),
    /All configured memory models failed/,
  );
  assert.deepEqual(searchMemoryMarkdown(root, "memory"), []);
  const first = await compileTaskMemory(fixture(root));
  const file = path.join(root, first.path);
  writeFileSync(file, readFileSync(file, "utf8") + "\nEdited by human.\n");
  await assert.rejects(
    compileTaskMemory(fixture(root, { expectedHash: first.hash, previous: first.memory })),
    /manual edits were preserved/,
  );
  assert.match(readFileSync(file, "utf8"), /Edited by human/);
});

test("persisted cursor resumes an append-only warm stage without reprocessing its prefix", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-cursor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await compileTaskMemory(fixture(root, { hotChars: 0 }));
  const memory = { ...first.memory };
  delete memory.source;
  const checkpoint = {
    id: first.record.id,
    tier: first.record.tier,
    path: first.path,
    hash: first.hash,
    cursor: first.cursor,
    branchCursor: first.branchCursor,
    memory,
  };
  const resumed = await compileTaskMemory(
    fixture(root, {
      hotChars: 0,
      checkpoint,
      run: async () => {
        throw Error("unchanged source must not invoke model");
      },
    }),
  );
  assert.equal(resumed.unchanged, true);
  assert.equal(resumed.hash, first.hash);
  const nextUser = entry("next-user", "result", "user", "Implement cold retrieval now");
  const nextAnswer = entry("next-answer", "next-user", "assistant", "Cold retrieval verified");
  const prompts = [];
  const second = await compileTaskMemory(
    fixture(root, {
      hotChars: 0,
      checkpoint,
      entries: [...entries, nextUser, nextAnswer],
      branchLeafId: "next-answer",
      run: async (_id, prompt) => {
        prompts.push(prompt);
        return "Local summary including cold retrieval";
      },
    }),
  );
  assert.equal(Object.hasOwn(second.cursor, "appended"), false);
  assert.equal(Object.hasOwn(second.branchCursor, "appended"), false);
  assert.ok(second.cursor.entries.length > first.cursor.entries.length);
  assert.ok(
    !JSON.stringify({ cursor: second.cursor, branchCursor: second.branchCursor }).includes("Cold retrieval verified"),
  );
  assert.ok(prompts[0].includes("Cold retrieval verified"));
  assert.ok(!prompts[0].includes("Design an offline memory system"));
  assert.ok(prompts[0].includes(JSON.stringify(first.memory.summary)));
});

test("disabled memory never contacts the model or writes files", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-compile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(
    await compileTaskMemory(
      fixture(root, {
        settings: { ...settings, enabled: false },
        run: async () => {
          throw Error("must not run");
        },
      }),
    ),
    null,
  );
});
