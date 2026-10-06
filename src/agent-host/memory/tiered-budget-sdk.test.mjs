import { ModelSessions } from "./model-sessions.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import * as zlib from "node:zlib";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { TieredBudgetController } from "./tiered-budget-controller.ts";
import { createFlashWarmRunner } from "./tiered-warm-remote.mjs";
import { buildTieredSnapshot } from "./tiered-workspace.mjs";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function fixture(
  t,
  {
    api = "openai-completions",
    codexReasoning = false,
    extensions = [],
    oldText,
    warm = false,
    reply = () => "FICTIONAL_REPLY",
    status = 200,
    customTools = [],
    beforeResponse = async () => {},
    installBudget = true,
    boundCwd,
    warmRunner,
    consentVersion,
    confirm = async () => true,
    adaptive = false,
    automatic = false,
    modelBindings = false,
    fresh = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-tiered-budget-fictional-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = boundCwd ?? join(root, "project");
  const agentDir = join(root, "agent");
  if (!existsSync(cwd)) mkdirSync(cwd);
  mkdirSync(agentDir);
  const captures = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    const body = JSON.parse(bytes.toString("utf8"));
    captures.push({ path: req.url, body }); // No headers/keys retained.
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Fictional temporary failure" } }));
      return;
    }
    await beforeResponse(body, captures.length);
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "openai-codex-responses") {
      const response = reply(body, captures.length);
      const calls = typeof response === "object" ? response.toolCalls : undefined;
      const text = calls ? "" : response;
      const message = {
        id: `msg_fixture_${captures.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const reasoning = {
        id: `rs_fixture_${captures.length}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Fictional reasoning summary" }],
        encrypted_content: "opaque-virtual-replay-not-text-tokens",
      };
      const events = [{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } }];
      const output = calls
        ? calls.map((call, index) => ({
            type: "function_call",
            id: `fc_fixture_${index}`,
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            status: "completed",
          }))
        : codexReasoning
          ? [reasoning, message]
          : [message];
      output.forEach((item, index) =>
        events.push(
          {
            type: "response.output_item.added",
            output_index: index,
            item: { ...item, content: item.type === "message" ? [] : undefined },
          },
          { type: "response.output_item.done", output_index: index, item },
        ),
      );
      events.push({
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output,
          usage: {
            input_tokens: 10,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: codexReasoning ? 20 : 0 },
          },
        },
      });
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    const base = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: body.model };
    const response = reply(body, captures.length);
    const toolCalls = typeof response === "object" ? response.toolCalls : undefined;
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...(toolCalls ? { tool_calls: toolCalls } : { content: response }) }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const [id, contextWindow] of [
    ["a", 32768],
    ["b", 4096],
  ])
    runtime.registerProvider(`fictional-${id}`, {
      api,
      apiKey:
        api === "openai-codex-responses"
          ? `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-only" } })).toString("base64")}.fake`
          : "fictional-local-only",
      baseUrl: `http://127.0.0.1:${server.address().port}/${id}`,
      models: [
        {
          id,
          name: `Fictional ${id}`,
          reasoning: false,
          input: ["text", "image"],
          contextWindow,
          maxTokens: 256,
          cost: usage.cost,
        },
      ],
    });
  const manager = SessionManager.create(cwd, join(root, "native"));
  manager.appendModelChange("fictional-a", "a");
  manager.appendMessage({ role: "system", content: "FICTIONAL_SYSTEM", timestamp: 1 });
  const user = (content) => manager.appendMessage({ role: "user", content, timestamp: 2 });
  const assistant = (content = "FICTIONAL_ACK") =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: content }],
      provider: "fictional-a",
      model: "a",
      api,
      usage,
      stopReason: "stop",
      timestamp: 3,
    });
  if (!fresh) {
    user(oldText ?? "Fictional old fact 17, planned not done.");
    assistant();
    const kept = user("Fictional latest span: rope, three boxes, deck. Not completed.");
    assistant();
    if (warm) manager.appendCompaction("FICTIONAL_WARM_PLAN_ONLY_17", kept, 100);
  }
  const prefix = existsSync(manager.getSessionFile()) ? readFileSync(manager.getSessionFile()) : Buffer.alloc(0);
  const bindings = new ModelSessions();
  const controller = new TieredBudgetController({
    adaptive,
    automatic,
    warmRunner: warmRunner ? (options) => warmRunner(runtime, options) : undefined,
    consentVersion,
    supports: (model) =>
      ["openai-completions", "openai-codex-responses"].includes(model.api) && model.provider.startsWith("fictional-"),
  });
  const nativeSettings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, provider: { maxRetries: 2 } },
    cacheWarming: "streaming",
    defaultThinkingLevel: "off",
    enableAnalytics: false,
    enableInstallTelemetry: false,
  });
  const nativeServices = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: runtime,
    settingsManager: nativeSettings,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => "FICTIONAL_SYSTEM",
      extensionFactories: [
        ...(modelBindings ? [bindings.extension()] : []),
        ...(installBudget ? [controller.extension()] : []),
        ...extensions,
      ],
    },
  });
  const services = {
    ...nativeServices,
    settingsManager: installBudget ? controller.wrapSettings(nativeSettings) : nativeSettings,
  };
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: runtime.getModel("fictional-a", "a"),
    thinkingLevel: "off",
    tools: customTools.map((tool) => tool.name),
    customTools,
  });
  if (installBudget) controller.install(session);
  if (modelBindings) bindings.install(session);
  const notices = [];
  const errors = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      confirm,
      notify: (text) => notices.push(text),
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => session.dispose());
  const enable = async ({ native = !warmRunner } = {}) => {
    await session.prompt("/tiered-budget-enable");
    assert.equal(controller.enabled, true, notices.join("\n"));
    // Native-budget fixtures explicitly opt into native summaries; production defaults to Flash.
    if (native) await session.prompt("/tiered-warm-native");
  };
  return {
    root,
    cwd,
    agentDir,
    manager,
    session,
    runtime,
    controller,
    bindings,
    nativeSettings,
    services,
    captures,
    notices,
    errors,
    prefix,
    enable,
  };
}
function plugin(factory) {
  return { name: "fictional-fixture-transform", factory };
}

test("new native sessions can send their first turn before Pi flushes the initial JSONL", async (t) => {
  for (const api of ["openai-completions", "openai-codex-responses"]) {
    const f = await fixture(t, { api, fresh: true, automatic: true, adaptive: true, modelBindings: true });
    assert.equal(existsSync(f.manager.getSessionFile()), false);
    await f.session.prompt("Fictional first request");
    assert.equal(f.captures.length, 1);
    assert.equal(existsSync(f.manager.getSessionFile()), true);
  }
});

test("Codex actual SSE request, catalog-output reserve and opaque replay across A-B-A", async (t) => {
  const f = await fixture(t, { api: "openai-codex-responses", codexReasoning: true, warm: true });
  await f.enable();
  await f.session.prompt("Fictional Codex A task");
  await f.session.setModel(f.runtime.getModel("fictional-b", "b"));
  await f.session.prompt("Fictional Codex B task");
  await f.session.setModel(f.runtime.getModel("fictional-a", "a"));
  await f.session.prompt("Fictional Codex A again");
  assert.equal(f.captures.length, 3);
  assert.ok(f.captures.every((capture) => capture.path.includes("/codex/responses")));
  assert.ok(f.captures.every(({ body }) => body.store === false && !Object.hasOwn(body, "max_output_tokens")));
  assert.ok(f.captures.at(-1).body.input.some((item) => item.type === "reasoning"));
  assert.equal(f.controller.lastReport.outputReserved, 256);
  assert.ok(f.controller.lastReport.totalEstimate.opaqueReserved > 0);
  assert.equal(f.controller.lastReport.action, "allow");
});

test("Codex SDK executes a complete parallel tool batch, then blocks its oversized continuation without splitting history", async (t) => {
  let executions = 0;
  const f = await fixture(t, {
    api: "openai-codex-responses",
    customTools: [
      {
        name: "fictional_batch",
        label: "Fictional batch",
        description: "Fictional read-only result",
        parameters: Type.Object({}),
        execute: async () => {
          executions++;
          return {
            content: [{ type: "text", text: "Fictional completed tool result ".repeat(2000) }],
            details: { fictionalOnly: true },
          };
        },
      },
    ],
    reply: (_body, index) =>
      index === 1
        ? {
            toolCalls: [0, 1].map((i) => ({
              index: i,
              id: `call_fixture_${i}`,
              type: "function",
              function: { name: "fictional_batch", arguments: "{}" },
            })),
          }
        : "FICTIONAL_REPLY",
  });
  await f.enable();
  await f.session.prompt("Fictional parallel tool task");
  assert.equal(f.captures.length, 1);
  const entries = f.manager.getBranch().filter((e) => e.type === "message");
  assert.equal(executions, 2);
  assert.equal(entries.filter((e) => e.message.role === "toolResult").length, 2);
  assert.equal(
    entries
      .filter((e) => e.message.role === "assistant")
      .flatMap((e) => e.message.content)
      .filter((block) => block.type === "toolCall").length,
    2,
  );
  assert.ok(!f.manager.getBranch().some((e) => e.type === "compaction"));
});

test("Codex final input transform overrun blocks before HTTP with no WS/retry fallback", async (t) => {
  const extension = {
    name: "fictional-codex-overrun",
    factory(pi) {
      pi.on("before_provider_request", ({ payload }) => ({
        ...payload,
        input: [...payload.input, { role: "user", content: [{ type: "input_text", text: "x".repeat(40000) }] }],
      }));
    },
  };
  const f = await fixture(t, { api: "openai-codex-responses", extensions: [extension] });
  await f.enable();
  await f.session.prompt("Fictional small request");
  assert.equal(f.captures.length, 0);
  assert.equal(f.controller.lastReport.action, "block");
});

function simulatedFlash(captures, { invalid = false, oversized = false, wait = async () => {} } = {}) {
  return (runtime, options) => {
    runtime.registerProvider("deepseek", {
      api: "openai-completions",
      apiKey: "fictional-flash-only",
      baseUrl: "https://api.deepseek.com",
      models: [
        {
          id: "deepseek-flash",
          name: "Fictional Flash transport",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 2048,
          cost: usage.cost,
          compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
        },
      ],
    });
    return createFlashWarmRunner({
      runtime,
      ...options,
      transport: async (url, config) => {
        assert.equal(new URL(url).origin, "https://api.deepseek.com");
        assert.equal(config.redirect, "error");
        const body = JSON.parse(config.body);
        captures.push(body);
        await wait();
        const source = JSON.parse(body.messages[1].content);
        const answer = JSON.stringify({
          sourceHash: source.sourceHash,
          summary: invalid
            ? null
            : oversized
              ? source.task
                ? "Fictional older fact 17; implementation verified, delivery pending."
                : "Fictional older fact 17. " + "重复说明".repeat(500)
              : source.records
                  .filter((record) => record.text.trim())
                  .map((record) =>
                    record.text.startsWith("Fictional older") ? "Fictional older fact 17. " : record.text,
                  )
                  .join("\n")
                  .slice(0, source.targetSummaryChars),
        });
        return new globalThis.Response(
          `data: ${JSON.stringify({ id: "fixture-flash", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture-flash", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
  };
}
test("adaptive small and medium histories send only the ordinary SDK request, without Flash compaction", async (t) => {
  for (const oldText of ["Fictional small history", "Fictional medium text. ".repeat(850)]) {
    const flash = [];
    const f = await fixture(t, { adaptive: true, oldText, warmRunner: simulatedFlash(flash, { long: true }) });
    await f.enable({ native: false });
    await f.session.prompt("Fictional continuation");
    assert.equal(flash.length, 0);
    assert.equal(f.captures.length, 1);
    assert.ok(!f.manager.getBranch().some((entry) => entry.type === "compaction"));
  }
});
test("reviewed long Flash source commits one native warm before a real SDK handoff request", async (t) => {
  const flash = [];
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(800),
    warmRunner: simulatedFlash(flash, { long: true }),
  });
  await f.enable({ native: false });
  await f.session.prompt("Fictional continuation after reviewed long history");
  assert.equal(flash.length, 1);
  assert.equal(f.captures.length, 1);
  const snapshot = buildTieredSnapshot(f.manager);
  assert.match(snapshot.warm.summary, /Fictional older fact 17/);
  assert.match(snapshot.warm.summary, /Original transcript/);
  assert.ok(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length).equals(f.prefix));
  assert.ok(!JSON.stringify(f.captures[0]).includes("Fictional older fact 17. ".repeat(800)));
});

test("incremental Flash SDK transport mock: one reviewed native warm, no selected-model summary or previous warm resend", async (t) => {
  const flash = [];
  const f = await fixture(t, { oldText: "Fictional older fact 17. ".repeat(400), warmRunner: simulatedFlash(flash) });
  await f.enable();
  await f.session.prompt("/tiered-budget-status");
  assert.equal(JSON.parse(f.notices.at(-1)).warmProcessor, "flash-per-attempt-review");
  assert.equal(flash.length, 0, "Default selection is not source permission");
  await f.session.prompt("Fictional next ordinary request after reviewed warm");
  assert.equal(flash.length, 1);
  assert.equal(f.captures.length, 1, "Only normal main request; no native summary fallback");
  const compactions = f.manager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, true);
  assert.equal(compactions[0].details.tieredWarm.review, "human-approved-not-proven");
  assert.equal(f.session.model.id, "a");
  assert.equal(flash[0].thinking.type, "disabled");
  assert.ok(!Object.hasOwn(flash[0], "reasoning_effort"));
  assert.ok(!flash[0].tools);
  const snapshot = buildTieredSnapshot(f.manager);
  assert.ok(snapshot.files["warm/summary.md"].includes("Fictional older fact 17"));
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
  await f.session.prompt("Fictional later hot span");
  await f.session.compact();
  assert.equal(flash.length, 2);
  assert.ok(!flash[1].messages[1].content.includes("older fact 17"), "Old cold source not resent");
  const last = f.manager
    .getBranch()
    .filter((entry) => entry.type === "compaction")
    .at(-1);
  assert.equal(last.details.tieredWarm.version, 2);
  assert.match(last.summary, /older fact 17/);
});

test("Missing default Flash processor refuses promotion without selected-model summary", async (t) => {
  const f = await fixture(t, { oldText: "Fictional older fact 17. ".repeat(400) });
  await f.enable({ native: false });
  await f.session.prompt("Fictional main input with missing Flash processor");
  assert.equal(f.captures.length, 1, "Only normal main input with original hot");
  assert.equal(f.manager.getBranch().filter((e) => e.type === "compaction").length, 0);
  assert.ok(f.notices.some((text) => text.includes("no native fallback")));
});

test("Flash default source refusal never falls back, explicit native selection resets on disable", async (t) => {
  const flash = [];
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(400),
    warmRunner: simulatedFlash(flash),
    confirm: async (title) => !title.includes("ONE incremental"),
  });
  await f.enable();
  await f.session.prompt("Fictional current main request with refused default Flash source");
  assert.equal(flash.length, 0);
  assert.equal(f.captures.length, 1, "Only ordinary main request; no native summary fallback");
  assert.equal(f.manager.getBranch().filter((e) => e.type === "compaction").length, 0);
  await f.session.prompt("/tiered-warm-native");
  await f.session.prompt("/tiered-budget-status");
  assert.equal(JSON.parse(f.notices.at(-1)).warmProcessor, "native");
  await f.session.prompt("/tiered-budget-disable");
  await f.session.prompt("/tiered-budget-status");
  const state = JSON.parse(f.notices.at(-1));
  assert.equal(state.enabled, false);
  assert.equal(state.warmProcessor, "flash-per-attempt-review");
  assert.equal(flash.length, 0);
});

test("Codex and reviewed Flash mock compose: incremental warm on A-B-A, opaque hot retained, second delta excludes reasoning", async (t) => {
  const flash = [];
  const f = await fixture(t, {
    api: "openai-codex-responses",
    codexReasoning: true,
    oldText: "Fictional older fact 17. ".repeat(400),
    warmRunner: simulatedFlash(flash),
  });
  await f.enable();
  await f.session.prompt("/tiered-warm-flash");
  await f.session.prompt("Fictional Codex A after warm");
  await f.session.setModel(f.runtime.getModel("fictional-b", "b"));
  await f.session.prompt("Fictional Codex B after warm");
  await f.session.setModel(f.runtime.getModel("fictional-a", "a"));
  await f.session.prompt("Fictional Codex A again after warm: " + "x".repeat(7800));
  assert.equal(flash.length, 2, "Large new span triggers the SDK's second incremental warm");
  assert.equal(f.captures.length, 3, "Only three main turns, never selected-model summary");
  for (const { body } of f.captures) {
    const items = body.input.filter((item) => JSON.stringify(item).includes("Fictional older fact 17"));
    assert.equal(items.length, 1, "Warm appears once in actual Responses input");
    assert.ok(!JSON.stringify(body).includes("Fictional older fact 17. ".repeat(2)), "Cold repetition is not restored");
  }
  assert.ok(f.captures.at(-1).body.input.some((item) => item.type === "reasoning"));
  const delta = JSON.parse(flash[1].messages[1].content);
  assert.ok(delta.records.some((record) => record.omittedReasoning));
  assert.ok(!flash[1].messages[1].content.includes("opaque-virtual-replay"));
  assert.ok(!flash[1].messages[1].content.includes("Fictional reasoning summary"));
  assert.ok(!flash[1].messages[1].content.includes("older fact 17"));
  const warm = f.manager
    .getBranch()
    .filter((entry) => entry.type === "compaction")
    .at(-1);
  assert.equal(warm.details.tieredWarm.version, 2);
  assert.match(warm.summary, /older fact 17/);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
});

test("Flash source denial, malformed facts or final review denial never promote or invoke native-summary fallback", async (t) => {
  for (const mode of ["source-denied", "bad-facts", "review-denied"]) {
    const flash = [];
    const f = await fixture(t, {
      oldText: "Fictional older fact 17. ".repeat(400),
      warmRunner: simulatedFlash(flash, { invalid: mode === "bad-facts" }),
      confirm: async (title) =>
        !(mode === "source-denied" && title.includes("ONE incremental")) &&
        !(mode === "review-denied" && title.includes("Review warm summary")),
    });
    await f.enable();
    await f.session.prompt("/tiered-warm-flash");
    await f.session.prompt("Fictional normal input despite failed warm");
    assert.equal(flash.length, mode === "source-denied" ? 0 : 1);
    assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.equal(f.captures.length, 1, "Only ordinary main request with original hot");
    await f.session.prompt("Fictional later input with failed warm paused");
    assert.equal(flash.length, mode === "source-denied" ? 0 : 1, "No automatic repeated Flash attempt");
  }
});

test("memory settings epoch change invalidates a pending Flash source even without model/branch change", async (t) => {
  let epoch = 0;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const flash = [];
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(400),
    consentVersion: () => epoch,
    warmRunner: simulatedFlash(flash, {
      wait: async () => {
        started();
        await hold;
      },
    }),
  });
  await f.enable();
  await f.session.prompt("/tiered-warm-flash");
  const request = f.session.prompt("Fictional pending consent epoch source");
  await ready;
  epoch += 2;
  release();
  await request;
  assert.equal(flash.length, 1);
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(f.captures.length, 1, "Only original-hot ordinary main request; no summary fallback");
});

test("Flash mock late completion after model switch cannot append its reviewed source", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const flash = [];
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(400),
    warmRunner: simulatedFlash(flash, {
      wait: async () => {
        started();
        await hold;
      },
    }),
  });
  await f.enable();
  await f.session.prompt("/tiered-warm-flash");
  const request = f.session.prompt("Fictional pending Flash source");
  await ready;
  await f.session.setModel(f.runtime.getModel("fictional-b", "b"));
  release();
  await request;
  assert.equal(flash.length, 1);
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(f.captures.length, 0);
});

test("budget controller installed but OFF is wire-identical to no controller across A-B-A", async (t) => {
  const baseline = await fixture(t, { installBudget: false, warm: true });
  const off = await fixture(t, { boundCwd: baseline.cwd, warm: true });
  for (const f of [baseline, off])
    for (const [id, text] of [
      ["a", "Fictional baseline A"],
      ["b", "Fictional baseline B"],
      ["a", "Fictional baseline A again"],
    ]) {
      await f.session.setModel(f.runtime.getModel(`fictional-${id}`, id));
      await f.session.prompt(text);
    }
  assert.equal(baseline.captures.length, 3);
  assert.equal(off.captures.length, 3);
  assert.deepEqual(off.captures, baseline.captures);
  assert.equal(off.controller.enabled, false);
});

test("reproduced SDK hook fail-open: a throwing payload hook alone still dispatches HTTP", async (t) => {
  const f = await fixture(t, {
    extensions: [
      plugin((pi) => {
        pi.on("before_provider_request", () => {
          throw new Error("FICTIONAL_EXTENSION_REFUSAL");
        });
      }),
    ],
  });
  await f.session.prompt("Fictional test of fail-open hook");
  assert.equal(f.captures.length, 1);
  assert.ok(f.errors.some((error) => error.event === "before_provider_request"));
  assert.equal(f.controller.enabled, false);
});

test("default off requests stay native; enabling does not dispatch, export, persist settings or permit Flash/Web", async (t) => {
  const f = await fixture(t);
  await f.session.prompt("Fictional normal native request");
  assert.equal(f.captures.length, 1);
  const history = readFileSync(f.manager.getSessionFile());
  const base = f.nativeSettings.getCompactionSettings(f.session.model);
  await f.enable();
  assert.equal(f.captures.length, 1);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), history);
  assert.equal(existsSync(join(f.agentDir, "settings.json")), false);
  assert.equal(existsSync(join(f.root, "project", `pi_agent_desktop_session-${f.session.sessionId}`)), false);
  assert.equal(f.services.settingsManager.getCacheWarmingMode(), "off");
  assert.equal(f.services.settingsManager.getRetrySettings().enabled, false);
  assert.equal(f.services.settingsManager.getProviderRetrySettings().maxRetries, 0);
  await f.session.prompt("/tiered-budget-disable");
  assert.deepEqual(f.services.settingsManager.getCompactionSettings(f.session.model), base);
  assert.equal(f.services.settingsManager.getCacheWarmingMode(), "streaming");
});

test("final callback blocks an oversized payload added AFTER preflight; zero HTTP requests", async (t) => {
  const f = await fixture(t, {
    extensions: [
      plugin((pi) => {
        pi.on("before_provider_request", (event) => ({
          ...event.payload,
          messages: [event.payload.messages[0], { role: "user", content: "Fictional ".repeat(2000) }],
        }));
      }),
    ],
  });
  await f.enable();
  await f.session.prompt("Small fictional request before transform");
  assert.equal(f.captures.length, 0);
  assert.equal(f.controller.lastReport.action, "block");
  assert.ok(f.controller.lastReport.reasons.includes("hot-envelope-limit"));
  assert.match(f.session.getLastAssistantText() ?? "", /^$/);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
});

test("A→small-window B→A preserves native warm; refused B has zero B dispatch or hidden retry", async (t) => {
  const f = await fixture(t, { warm: true });
  await f.enable();
  await f.session.prompt("Fictional request A");
  assert.equal(f.captures.length, 1);
  const warmId = f.manager.getBranch().find((entry) => entry.type === "compaction").id;
  await f.session.setModel(f.runtime.getModel("fictional-b", "b"));
  await f.session.prompt("Large new current request ".repeat(120));
  assert.equal(f.captures.filter((capture) => capture.path.startsWith("/b/")).length, 0);
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  await f.session.setModel(f.runtime.getModel("fictional-a", "a"));
  await f.session.prompt("Fictional continuation A after refusal");
  assert.equal(f.captures.filter((capture) => capture.path.startsWith("/b/")).length, 0);
  assert.equal(
    f.manager.getBranch().some((entry) => entry.id === warmId),
    true,
  );
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
  const last = JSON.stringify(f.captures.at(-1).body.messages);
  assert.equal(last.split("FICTIONAL_WARM_PLAN_ONLY_17").length - 1, 1);
  assert.match(last, /Large new current request/);
});

test("SDK owns one compaction; long older text replaced once while latest user span remains verbatim", async (t) => {
  const f = await fixture(t, {
    oldText: "Fictional older archived fact 17. ".repeat(340),
    reply: (_body, index) => (index === 1 ? "FICTIONAL_COMPACT_FACT_17_PLAN_ONLY" : "FICTIONAL_REPLY"),
  });
  await f.enable();
  await f.session.prompt("Fictional current request after native compaction");
  assert.equal(
    f.captures.length,
    2,
    JSON.stringify({
      controller: f.controller.enabled,
      settings: f.services.settingsManager.getCompactionSettings(f.session.model),
      report: f.controller.lastReport,
      errors: f.errors,
      notices: f.notices,
      lastError: f.session.messages.at(-1)?.errorMessage,
    }),
  );
  const entries = f.manager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary, "FICTIONAL_COMPACT_FACT_17_PLAN_ONLY");
  const sent = JSON.stringify(f.captures[1].body.messages);
  assert.match(sent, /Fictional latest span/);
  assert.match(sent, /current request after native compaction/);
  assert.doesNotMatch(sent, /older archived fact/);
  assert.equal(sent.split("FICTIONAL_COMPACT_FACT_17_PLAN_ONLY").length - 1, 1);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
});

test("oversized generated warm is rejected BEFORE native compaction append; original hot stays available", async (t) => {
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(400),
    reply: (_body, index) => (index === 1 ? "Fictional oversized summary ".repeat(200) : "FICTIONAL_REPLY"),
  });
  await f.enable();
  await f.session.prompt("Fictional current request when warm candidate fails");
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
  assert.ok(
    f.manager
      .buildSessionProjection()
      .messages.some(
        (message) =>
          message.role === "user" && typeof message.content === "string" && message.content.includes("older fact 17"),
      ),
  );
  assert.equal(
    f.captures.length,
    2,
    "One failed warm candidate and one ordinary full-hot request, no automatic summary retry",
  );
  await f.session.prompt("Fictional later request while compaction paused");
  assert.equal(f.captures.length, 3, "Pause survives later normal turns");
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  await f.session.compact();
  assert.equal(f.captures.length, 4, "Explicit manual retry is a separate source request");
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
});

test("503 from the normal provider has one dispatch with session/provider retries suppressed", async (t) => {
  const f = await fixture(t, { status: 503 });
  await f.enable();
  await f.session.prompt("Fictional single failing request");
  assert.equal(f.captures.length, 1);
});

test("permission revoked while a payload transform is pending stops late dispatch", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    extensions: [
      plugin((pi) => {
        pi.on("before_provider_request", async () => {
          started();
          await hold;
        });
      }),
    ],
  });
  await f.enable();
  const request = f.session.prompt("Fictional pending serialization");
  await ready;
  await f.session.prompt("/tiered-budget-disable");
  release();
  await request;
  assert.equal(f.captures.length, 0);
  assert.equal(f.controller.enabled, false);
});

test("real SDK tool continuation: oversized completed tool batch stays hot and second HTTP request is blocked", async (t) => {
  const resultText = "Fictional tool source with exact 17. ".repeat(520);
  const f = await fixture(t, {
    customTools: [
      {
        name: "fictional_read",
        label: "Fictional",
        description: "Fixture only",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: resultText }], details: {} }),
      },
    ],
    reply: () => ({
      toolCalls: [
        { index: 0, id: "fictional-tool-17", type: "function", function: { name: "fictional_read", arguments: "{}" } },
      ],
    }),
  });
  await f.enable();
  await f.session.prompt("Fictional current task: run fictional_read; preserve all returned source.");
  assert.equal(
    f.captures.length,
    1,
    "Only the initial tool-call response; no summary or over-budget continuation request",
  );
  const projection = f.manager.buildSessionProjection().messages;
  assert.ok(
    projection.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "toolCall" && block.id === "fictional-tool-17"),
    ),
  );
  assert.equal(
    projection.find((message) => message.role === "toolResult" && message.toolCallId === "fictional-tool-17").content[0]
      .text,
    resultText,
  );
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(f.controller.lastReport.action, "block");
});

test("model switch during native summary aborts the old candidate; no old compaction or B request", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(500),
    beforeResponse: async (_body, count) => {
      if (count === 1) {
        started();
        await hold;
      }
    },
    reply: () => "FICTIONAL_LATE_WARM",
  });
  await f.enable();
  const request = f.session.prompt("Fictional current input while native summary is pending");
  await ready;
  await f.session.setModel(f.runtime.getModel("fictional-b", "b"));
  release();
  await request;
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(f.captures.filter((capture) => capture.path.startsWith("/b/")).length, 0);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
});

test("native JSONL changed outside SDK during summary cannot commit or dispatch a stale chat projection", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(500),
    beforeResponse: async (_body, count) => {
      if (count === 1) {
        started();
        await hold;
      }
    },
    reply: () => "FICTIONAL_LATE_WARM",
  });
  await f.enable();
  const request = f.session.prompt("Fictional current source conflict test");
  await ready;
  const path = f.manager.getSessionFile();
  const changed = readFileSync(path, "utf8").replace("older fact 17", "older fact 19");
  writeFileSync(path, changed);
  release();
  await request;
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(f.captures.length, 1, "Only the already-dispatched summary; stale ordinary chat is refused");
  assert.match(readFileSync(path, "utf8"), /older fact 19/);
});

test("real SDK commits one warm only after every bounded incremental segment returns and review passes", async (t) => {
  const flash = [];
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(1200),
    warmRunner: simulatedFlash(flash, { long: true }),
  });
  for (let i = 0; i < 5; i++)
    f.manager.appendMessage({ role: "user", content: "Fictional older fact 17. ".repeat(1200), timestamp: 3 + i });
  f.manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Fictional prior turn ended." }],
    api: "openai-completions",
    provider: "fictional-a",
    model: "a",
    stopReason: "stop",
    usage,
    timestamp: 10,
  });
  f.manager.appendMessage({ role: "user", content: "Fictional short latest span.", timestamp: 11 });
  f.session.refreshContext();
  await f.enable();
  await f.session.prompt("Fictional latest delivery still pending.");
  assert.ok(flash.length > 1, JSON.stringify({ notices: f.notices, errors: f.errors }));
  for (const request of flash) assert.ok(Buffer.byteLength(request.messages[1].content) <= 64 * 1024);
  assert.equal(
    f.manager.getBranch().filter((e) => e.type === "compaction").length,
    1,
    JSON.stringify({ notices: f.notices, errors: f.errors }),
  );
  assert.equal(
    f.captures.length,
    1,
    JSON.stringify({
      notices: f.notices,
      errors: f.errors,
      report: f.controller.lastReport,
      last: f.session.messages.at(-1),
    }),
  );
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
});

test("oversized Flash summaries are consolidated without resending original history before one native commit", async (t) => {
  const flash = [];
  const f = await fixture(t, {
    oldText: "Fictional older fact 17. ".repeat(400),
    warmRunner: simulatedFlash(flash, { oversized: true }),
  });
  await f.enable({ native: false });
  await f.session.prompt("Continue after memory reduction");
  assert.equal(flash.length, 2);
  const input = JSON.parse(flash[1].messages[1].content);
  assert.ok(input.task.includes("合并"));
  assert.ok(!input.records[0].text.includes("Fictional older fact 17. ".repeat(2)));
  const entries = f.manager.getBranch().filter((e) => e.type === "compaction");
  assert.equal(entries.length, 1);
  assert.match(entries[0].summary, /delivery pending/);
  assert.equal(entries[0].details.tieredWarm.version, 1);
  assert.ok(entries[0].details.tieredWarm.consolidationSourceHash);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, f.prefix.length), f.prefix);
});

test("automatic policy sends image batches before final request and restores original A binding after B", async (t) => {
  const f = await fixture(t, { adaptive: true, automatic: true, modelBindings: true });
  assert.equal(f.controller.enabled, true);
  const images = Array.from({ length: 9 }, (_, i) => ({
    type: "image",
    mimeType: "image/png",
    data: Buffer.from(`fictional-image-${i}`).toString("base64"),
  }));
  await f.session.prompt("FINAL_IMAGE_TASK", { images });
  assert.equal(f.captures.length, 3);
  const imageCount = (body) =>
    body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "image_url")
      .length;
  assert.deepEqual(
    f.captures.map((c) => imageCount(c.body)),
    [8, 1, 0],
  );
  assert.match(JSON.stringify(f.captures.at(-1).body), /FINAL_IMAGE_TASK/);
  assert.doesNotMatch(JSON.stringify(f.captures[0].body), /FINAL_IMAGE_TASK/);
  const a = f.bindings.currentId();
  assert.equal(a, f.session.sessionId);
  await f.session.setModel({ ...f.runtime.getModel("fictional-b", "b"), contextWindow: 32768 });
  await f.session.prompt("B_FINAL_TASK");
  const b = f.bindings.currentId();
  assert.notEqual(a, b);
  assert.deepEqual(
    f.captures.slice(3).map((c) => imageCount(c.body)),
    [8, 1, 0],
  );
  await f.session.setModel(f.runtime.getModel("fictional-a", "a"));
  await f.session.prompt("A_RETURN_TASK");
  assert.equal(f.bindings.currentId(), a);
  assert.equal(imageCount(f.captures.at(-1).body), 0);
  const all = JSON.stringify(f.manager.getEntries());
  for (const image of images) assert.ok(all.includes(image.data), "raw images retained in cool");
});

test("automatic large-context warm summarizes text incrementally without per-segment dialogs", async (t) => {
  const plans = [];
  const f = await fixture(t, {
    adaptive: true,
    automatic: true,
    oldText: "Earlier useful task evidence. ".repeat(4000),
    confirm: () => {
      throw new Error("Automatic policy must not require a manual dialog");
    },
    warmRunner:
      (_runtime, { authorized }) =>
      async (plan) => {
        assert.equal(authorized(), true);
        plans.push(plan);
        return {
          answer: JSON.stringify({
            sourceHash: plan.sourceHash,
            summary: "Earlier useful decisions remain available; current work is pending.",
          }),
        };
      },
  });
  await f.session.prompt("Continue the current work.");
  assert.ok(plans.length > 1);
  assert.ok(plans.every((plan) => Buffer.byteLength(plan.payload) <= 64 * 1024));
  assert.equal(f.captures.length, 1);
  assert.match(JSON.stringify(f.captures[0].body), /Earlier useful decisions/);
  assert.doesNotMatch(JSON.stringify(f.captures[0].body), /Earlier useful task evidence/);
  const entry = f.manager.getEntries().findLast((e) => e.type === "compaction");
  assert.equal(entry.details.tieredWarm.review, "automatic-summary-not-proven");
  assert.ok(
    f.manager
      .getEntries()
      .some((e) => e.type === "message" && e.message.content === "Earlier useful task evidence. ".repeat(4000)),
  );
});

test("large-context model switch generates warm before the next target request", async (t) => {
  const plans = [];
  const f = await fixture(t, {
    adaptive: true,
    automatic: true,
    oldText: "Old evidence. ".repeat(7000),
    warmRunner: () => async (plan) => {
      plans.push(plan);
      return {
        answer: JSON.stringify({ sourceHash: plan.sourceHash, summary: "Old useful evidence summarized for handoff." }),
      };
    },
  });
  await f.session.setModel({ ...f.runtime.getModel("fictional-b", "b"), contextWindow: 32768 });
  assert.ok(plans.length > 0);
  assert.equal(f.captures.length, 0);
  assert.ok(f.manager.getEntries().some((e) => e.type === "compaction"));
});

test("API model session can detach, create a new identity, and rebind its saved original", async (t) => {
  const f = await fixture(t, { automatic: true, adaptive: true, modelBindings: true });
  await f.session.prompt("First request");
  const original = f.bindings.currentId();
  await f.session.prompt("/model-session unbind");
  assert.equal(f.bindings.currentId(), undefined);
  await f.session.prompt("New session request");
  assert.notEqual(f.bindings.currentId(), original);
  await f.session.prompt(`/model-session bind ${original}`);
  assert.equal(f.bindings.currentId(), original);
  const restored = new ModelSessions();
  restored.restore(f.manager);
  assert.equal(restored.currentId(), original);
  assert.equal(f.captures.length, 2);
});
