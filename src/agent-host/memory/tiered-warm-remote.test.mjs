import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importTestBundle } from "#test-bundle";
import { zstdDecompressSync } from "node:zlib";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
const { ProviderAccounts } = await importTestBundle("warm-provider-accounts", {
  packages: "external",
  absWorkingDir: path.resolve(import.meta.dirname, "../../.."),
  entryPoints: [path.resolve(import.meta.dirname, "../provider-accounts.ts")],
});
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

test("Codex account warm candidates require official route, explicit off support and isolated account registration", async () => {
  const first = {
    ...model,
    provider: "desktop-account-first",
    id: "gpt-6-sol",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    thinkingLevelMap: { off: "none" },
  };
  const second = { ...first, provider: "desktop-account-second" };
  const registered = { getRegisteredNativeProvider: (id) => ({ name: `Codex · ${id}` }) };
  assert.equal(supportsWarmModel(first, registered), true);
  assert.equal(supportsWarmModel(second, registered), true);
  for (const invalid of [
    { ...first, baseUrl: "https://example.test/backend-api" },
    { ...first, thinkingLevelMap: { off: null } },
    { ...first, provider: "custom" },
  ])
    assert.equal(supportsWarmModel(invalid, registered), false);
  assert.equal(supportsWarmModel(first, { getRegisteredNativeProvider: () => ({ name: "Impostor" }) }), false);
  const registry = {
    ...registered,
    getModels: () => [first, second],
    getAvailable: async (id) => [first, second].filter((m) => m.provider === id),
  };
  assert.deepEqual(await listWarmModels(registry), [
    "desktop-account-first/gpt-6-sol",
    "desktop-account-second/gpt-6-sol",
  ]);
});

test("two Codex accounts send warm through their own scoped OAuth tokens and never fall back", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-warm-codex-"));
  const agent = path.join(root, "agent");
  mkdirSync(agent);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const accounts = new ProviderAccounts(agent);
  const rows = [accounts.add("codex", "Personal"), accounts.add("codex", "Company")];
  const claim = "https://api.openai.com/auth";
  const token = (id) =>
    `x.${Buffer.from(JSON.stringify({ [claim]: { chatgpt_account_id: id } })).toString("base64url")}.signature`;
  for (const [index, row] of rows.entries()) {
    writeFileSync(
      path.join(agent, "accounts", row.id, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: token(index === 0 ? "personal-id" : "company-id"),
          refresh: "fictional-refresh",
          expires: Date.now() + 3_600_000,
        },
      }),
    );
  }
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: path.join(agent, "empty.json"),
    allowModelNetwork: false,
  });
  await accounts.install(runtime);
  const calls = [];
  const transport = async (url, options) => {
    const bytes = typeof options.body === "string" ? Buffer.from(options.body) : Buffer.from(options.body);
    const body = JSON.parse(
      (bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? zstdDecompressSync(bytes) : bytes).toString(
        "utf8",
      ),
    );
    const header = new globalThis.Headers(options.headers).get("authorization");
    calls.push({
      url: String(url),
      model: body.model,
      account:
        header === `Bearer ${token("personal-id")}`
          ? "personal"
          : header === `Bearer ${token("company-id")}`
            ? "company"
            : "unknown",
      body,
    });
    const message = {
      id: `msg-${calls.length}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "{}", annotations: [] }],
    };
    const events = [
      { type: "response.created", response: { id: `resp-${calls.length}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: `resp-${calls.length}`,
          status: "completed",
          output: [message],
          usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } },
        },
      },
    ];
    return new globalThis.Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const targets = rows.map((row) => `${row.provider}/gpt-6-sol`);
  for (const target of targets) {
    const reply = await createFlashWarmRunner({
      runtime,
      accountStore: accounts,
      target,
      authorized: () => true,
      transport,
    })(plan);
    assert.equal(reply.answer, "{}");
  }
  assert.deepEqual(
    calls.map(({ account }) => account),
    ["personal", "company"],
  );
  for (const call of calls) {
    assert.equal(call.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(call.body.store, false);
    assert.equal(call.body.tool_choice, "none");
    assert.equal(call.body.reasoning?.effort, "none");
    assert.equal(call.body.prompt_cache_key, undefined);
    assert.equal(call.body.input.length, 1);
    assert.equal(call.body.input[0].content[0].text, plan.payload);
  }
  const company = rows[1];
  writeFileSync(path.join(agent, "accounts", company.id, "auth.json"), "{}");
  await assert.rejects(
    createFlashWarmRunner({ runtime, accountStore: accounts, target: targets[1], authorized: () => true, transport })(
      plan,
    ),
    /no retry/,
  );
  assert.equal(calls.length, 2, "Missing company credentials must not dispatch or fall back to personal");
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
