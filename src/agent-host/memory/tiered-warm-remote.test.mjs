import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlashWarmRunner } from "./tiered-warm-remote.mjs";
const model = {
  provider: "deepseek",
  id: "deepseek-flash",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 131072,
  maxTokens: 2048,
};
const plan = { payload: JSON.stringify({ sourceHash: "fictional", records: [] }) };
function runtime({
  wire = (value) => value,
  url = "https://api.deepseek.com/chat/completions",
  after = () => {},
  twice = false,
  stopReason = "stop",
} = {}) {
  return {
    getModel: () => model,
    completeSimple: async (selected, context, config) => {
      assert.equal(config.reasoning, "off");
      assert.equal(config.maxRetries, 0);
      assert.equal(config.cacheRetention, "none");
      const body = {
        model: selected.id,
        thinking: { type: "disabled" },
        max_tokens: config.maxTokens,
        messages: context.messages,
      };
      config.onPayload(body, selected);
      await config.fetch(url, { method: "POST", body: JSON.stringify(wire(body)) });
      if (twice) await config.fetch(url, { method: "POST", body: JSON.stringify(body) });
      after();
      return { stopReason, content: [{ type: "text", text: "{}" }] };
    },
  };
}
test("Flash final serialized body/domain/off checks block altered wire and extra dispatch without fallback", async () => {
  let calls = 0;
  const transport = async (_url, opts) => {
    calls++;
    assert.equal(opts.redirect, "error");
    return {};
  };
  for (const wire of [
    (b) => ({ ...b, thinking: { type: "enabled" } }),
    (b) => ({ ...b, tools: [] }),
    (b) => ({ ...b, reasoning_effort: "low" }),
    (b) => ({ ...b, messages: b.messages.slice(0, 1) }),
    (b) => ({ ...b, max_tokens: 4096 }),
  ])
    await assert.rejects(
      createFlashWarmRunner({ runtime: runtime({ wire }), authorized: () => true, transport })(plan),
      /no retry/,
    );
  for (const url of [
    "https://evil.invalid/chat/completions",
    "https://api.deepseek.com/chat/completions?x=1",
    "https://user@api.deepseek.com/chat/completions",
  ])
    await assert.rejects(
      createFlashWarmRunner({ runtime: runtime({ url }), authorized: () => true, transport })(plan),
      /no retry/,
    );
  assert.equal(calls, 0);
  await assert.rejects(
    createFlashWarmRunner({ runtime: runtime({ twice: true }), authorized: () => true, transport })(plan),
    /no retry/,
  );
  assert.equal(calls, 1);
});
test("unapproved/custom implementations, revoked results and provider errors do not grant source or leak diagnostics", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return {};
  };
  await assert.rejects(
    createFlashWarmRunner({ runtime: runtime(), authorized: () => false, transport })(plan),
    /no retry/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    createFlashWarmRunner({
      runtime: { ...runtime(), getRegisteredNativeProvider: () => ({}) },
      authorized: () => true,
      transport,
    })(plan),
    /no retry/,
  );
  assert.equal(calls, 0);
  let grant = true;
  await assert.rejects(
    createFlashWarmRunner({
      runtime: runtime({
        after: () => {
          grant = false;
        },
      }),
      authorized: () => grant,
      transport,
    })(plan),
    /no retry/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    createFlashWarmRunner({
      runtime: {
        getModel: () => {
          throw Error("sk-fictional-secret-not-to-log");
        },
      },
      authorized: () => true,
      transport,
    })(plan),
    (error) => !error.message.includes("sk-fictional"),
  );
});
