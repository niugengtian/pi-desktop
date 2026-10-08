import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWarmModelSettings, saveWarmModelSettings } from "./warm-model-settings.ts";

test("warm default persists separately, rejects stale writes and retains private file permissions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-warm-settings-"));
  try {
    const initial = readWarmModelSettings(dir);
    assert.equal(initial.model, "deepseek/deepseek-flash");
    const saved = saveWarmModelSettings("desktop-account-fictional/gpt-6-sol", initial.version, dir);
    assert.deepEqual(readWarmModelSettings(dir), saved);
    assert.throws(() => saveWarmModelSettings("ollama-local/qwen", initial.version, dir), /changed/);
    assert.equal(statSync(path.join(dir, "warm-model.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
