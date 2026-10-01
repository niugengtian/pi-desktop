import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlashMemoryRunner, FLASH_MEMORY_MODEL, remoteSourcePreview } from "./remote-model.mjs";
import { parseMemoryModelSettings } from "../../shared/memory-model.ts";

const model = {
  provider: "deepseek",
  id: "deepseek-flash",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
};
function runtime(options = {}) {
  return {
    getModel: () => options.model ?? model,
    completeSimple: async (selected, context, config) => {
      options.called?.();
      assert.equal(config.reasoning, "off");
      assert.equal(config.maxRetries, 0);
      const body = {
        model: selected.id,
        thinking: { type: options.thinking ?? "disabled" },
        messages: context.messages,
        max_tokens: config.maxTokens,
      };
      config.onPayload(body, selected);
      await config.fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: JSON.stringify(options.wire ? options.wire(body) : body),
      });
      options.after?.();
      return { stopReason: "stop", content: [{ type: "text", text: "目标：先检查帆绳，再清点苹果。" }] };
    },
  };
}

test("remote sources and settings fail closed for tools, summaries, oversize and fallbacks", () => {
  assert.equal(
    remoteSourcePreview([{ role: "user", text: "Fictional task" }]),
    '{"role":"user","text":"Fictional task"}',
  );
  for (const role of ["toolResult", "compactionSummary", "branchSummary", "system"]) {
    assert.throws(() => remoteSourcePreview([{ role, text: "Sensitive tool text" }]), /separate approval/);
  }
  assert.throws(() => remoteSourcePreview([{ role: "user", text: "x".repeat(12001) }]), /approval limit/);
  assert.throws(
    () => parseMemoryModelSettings({ enabled: true, primary: FLASH_MEMORY_MODEL, fallback: "ollama-local/local" }),
    /no fallback/,
  );
  assert.throws(
    () => parseMemoryModelSettings({ enabled: true, primary: "ollama-local/local", fallback: FLASH_MEMORY_MODEL }),
    /no fallback/,
  );
});

test("Flash requires consent and official endpoint; actual payload disables thinking and redirects", async (t) => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    return {};
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  await assert.rejects(
    createFlashMemoryRunner({ runtime: runtime(), authorized: () => false })(FLASH_MEMORY_MODEL, "data"),
    /not authorized/,
  );
  await assert.rejects(
    createFlashMemoryRunner({
      runtime: runtime({ model: { ...model, baseUrl: "https://evil.invalid" } }),
      authorized: () => true,
    })(FLASH_MEMORY_MODEL, "data"),
    /official API/,
  );
  assert.equal(calls, 0);
  const run = createFlashMemoryRunner({ runtime: runtime(), authorized: () => true });
  assert.match(await run(FLASH_MEMORY_MODEL, "You process task memory LOCALLY.\nFictional data"), /检查帆绳/);
  assert.equal(calls, 1);
  await assert.rejects(
    createFlashMemoryRunner({ runtime: runtime({ thinking: "enabled" }), authorized: () => true })(
      FLASH_MEMORY_MODEL,
      "data",
    ),
    /no retry/,
  );
  assert.equal(calls, 1, "wrong thinking mode must not dispatch");
  await assert.rejects(
    createFlashMemoryRunner({
      runtime: runtime({ wire: (body) => ({ ...body, thinking: { type: "enabled" } }) }),
      authorized: () => true,
    })(FLASH_MEMORY_MODEL, "data"),
    /no retry/,
  );
  assert.equal(calls, 1, "serialization changes after onPayload must not dispatch");
});

test("revoked consent and raw auth errors do not deliver a remote result or reveal secrets", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({});
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let allowed = true;
  const run = createFlashMemoryRunner({
    runtime: runtime({
      after: () => {
        allowed = false;
      },
    }),
    authorized: () => allowed,
  });
  await assert.rejects(run(FLASH_MEMORY_MODEL, "Fictional data"), /authorization changed/);
  const broken = {
    getModel: () => model,
    completeSimple: async () => {
      throw Error("sk-secret-test-value");
    },
  };
  await assert.rejects(
    createFlashMemoryRunner({ runtime: broken, authorized: () => true })(FLASH_MEMORY_MODEL, "data"),
    (error) => !error.message.includes("sk-secret") && error.message.includes("no retry"),
  );
});
