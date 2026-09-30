import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSessionModel } from "./session-model.ts";

test("selecting a newly listed model reloads only the local provider cache", async () => {
  const calls = [];
  const published = { provider: "openai-codex", id: "gpt-6.1-sol" };
  let current;
  const runtime = {
    getModel: (provider, modelId) =>
      provider === published.provider && modelId === published.id ? current : undefined,
    refresh: async (options) => {
      calls.push(options);
      current = published;
    },
  };
  assert.equal(await resolveSessionModel(runtime, published.provider, published.id), published);
  assert.deepEqual(calls, [{ allowNetwork: false, providers: ["openai-codex"] }]);
});

test("a model already in the session runtime needs no refresh", async () => {
  const existing = { provider: "openai-codex", id: "gpt-6-sol" };
  const runtime = {
    getModel: () => existing,
    refresh: () => {
      throw new Error("unnecessary refresh");
    },
  };
  assert.equal(await resolveSessionModel(runtime, existing.provider, existing.id), existing);
});

test("unknown models still fail closed after a local refresh", async () => {
  let count = 0;
  const runtime = {
    getModel: () => undefined,
    refresh: async (options) => {
      assert.deepEqual(options, { allowNetwork: false, providers: ["openai-codex"] });
      count++;
    },
  };
  await assert.rejects(
    resolveSessionModel(runtime, "openai-codex", "missing"),
    /Model not found: openai-codex\/missing/,
  );
  assert.equal(count, 1);
});
