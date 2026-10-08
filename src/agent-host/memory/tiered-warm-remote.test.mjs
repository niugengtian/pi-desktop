import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlashWarmRunner, listWarmModels, supportsWarmModel } from "./tiered-warm-remote.mjs";
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
        stream: true,
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
test("available configured completions models include HTTPS API and loopback Ollama, not Web, LAN or overridden providers", async () => {
  const api = { ...model, provider: "my-api", id: "summarizer", baseUrl: "https://example.test/v1" };
  const ollama = { ...model, provider: "ollama-local", id: "qwen:latest", baseUrl: "http://127.0.0.1:11434/v1" };
  const customLocal = { ...ollama, provider: "my-local", id: "local" };
  const web = { ...api, provider: "opencli-page" };
  const lan = { ...ollama, baseUrl: "http://192.168.1.10:11434/v1" };
  assert.equal(supportsWarmModel(api), true);
  assert.equal(supportsWarmModel(ollama), true);
  assert.equal(supportsWarmModel(customLocal), true);
  for (const rejected of [
    web,
    lan,
    { ...api, api: "anthropic-messages" },
    { ...api, baseUrl: "http://example.test/v1" },
    { ...api, baseUrl: "https://example.test/v1?key=secret" },
    { ...api, contextWindow: 1024 },
    { ...api, samplingParams: { temperature: 1 } },
  ])
    assert.equal(supportsWarmModel(rejected), false);
  const registry = {
    getModels: () => [api, ollama, web, lan],
    getAvailable: async (provider) => (provider === "my-api" ? [api] : [ollama]),
  };
  assert.deepEqual(await listWarmModels(registry), ["my-api/summarizer", "ollama-local/qwen:latest"]);
  assert.equal(supportsWarmModel(api, { getRegisteredNativeProvider: () => ({}) }), false);
  assert.equal(supportsWarmModel(api, { getRegisteredProviderConfig: () => ({ streamSimple() {} }) }), false);
  const offline = {
    ...registry,
    getAvailable: async () => {
      throw Error("offline");
    },
  };
  assert.deepEqual(await listWarmModels(offline), []);
});

test("selected API or local Ollama endpoint and final body are checked without silent fallback", async () => {
  const api = { ...model, provider: "my-api", id: "summarizer", baseUrl: "https://example.test/v1" };
  const ollama = { ...model, provider: "ollama-local", id: "qwen:latest", baseUrl: "http://127.0.0.1:11434/v1" };
  for (const selected of [api, ollama]) {
    const calls = [];
    const fixture = runtime({ url: `${selected.baseUrl}/chat/completions` });
    fixture.getModel = (provider, id) => (provider === selected.provider && id === selected.id ? selected : undefined);
    const answer = await createFlashWarmRunner({
      runtime: fixture,
      target: `${selected.provider}/${selected.id}`,
      authorized: () => true,
      transport: async (url, options) => {
        calls.push({ url, options });
        return { status: 200 };
      },
    })(plan);
    assert.equal(answer.answer, "{}");
    assert.equal(calls.length, 1);
    const forged = runtime({ url: `${selected.baseUrl}/chat/completions?intercept=1` });
    forged.getModel = fixture.getModel;
    await assert.rejects(
      createFlashWarmRunner({
        runtime: forged,
        target: `${selected.provider}/${selected.id}`,
        authorized: () => true,
        transport: () => {
          throw new Error("must not send");
        },
      })(plan),
      /no retry/,
    );
  }
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
