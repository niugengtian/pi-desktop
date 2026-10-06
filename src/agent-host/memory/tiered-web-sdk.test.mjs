import { ModelSessions } from "./model-sessions.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { TieredBudgetController } from "./tiered-budget-controller.ts";
const packagePath = process.env.PI_TIERED_PAGE_PACKAGE;
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
    accept = true,
    mutatePayload = false,
    mutateAtDispatch = false,
    mutateBeforeReply = false,
    modelBindings = false,
    automatic = false,
    fresh = false,
    unconfirmed = false,
    forceEmptyPrompt = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-contract-fictional-"));
  const capture = join(root, "captures.jsonl");
  mkdirSync(join(root, "dist/src"), { recursive: true });
  mkdirSync(join(root, "project"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@jackwener/opencli",
      type: "module",
      exports: {
        "./registry": "./dist/src/registry-api.js",
        "./errors": "./dist/src/errors.js",
        "./utils": "./dist/src/utils.js",
      },
    }),
  );
  writeFileSync(
    join(root, "dist/src/registry-api.js"),
    "export const cli = c => c; export const Strategy = {COOKIE:'cookie'};",
  );
  writeFileSync(
    join(root, "dist/src/errors.js"),
    "export class CliError extends Error {} export class ArgumentError extends CliError {} export class CommandExecutionError extends CliError {} export class TimeoutError extends CliError {} export class AuthRequiredError extends CliError {} export const EXIT_CODES={};",
  );
  writeFileSync(join(root, "dist/src/utils.js"), "export const htmlToMarkdown=s=>s;");
  for (const site of ["chatgpt", "deepseek"]) {
    mkdirSync(join(root, "clis", site), { recursive: true });
    writeFileSync(
      join(root, "clis", site, "ask.js"),
      `export const askCommand={site:${JSON.stringify(site)},pageProviderDispatchContract:'pi-tiered-web-1'};`,
    );
  }
  writeFileSync(
    join(root, "dist/src/execution.js"),
    `
    import {appendFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
    export async function executeCommand(command,kwargs){
      await kwargs.beforeSubmit(kwargs.prompt);
      appendFileSync(${JSON.stringify(capture)},JSON.stringify({site:command.site,think:kwargs.think,text:kwargs.prompt,new:kwargs.new,conversation:kwargs.conversation,images:Array.isArray(kwargs.file)?kwargs.file.length:kwargs.file?1:0})+'\\n');
      const id='fictional_remote'; const url=command.site==='chatgpt'?'https://chatgpt.com/c/'+id:'https://chat.deepseek.com/a/chat/s/'+id;
      await kwargs.onConversation({conversationId:id,conversationUrl:url});
      const response='FICTIONAL_WEB_REPLY_'+command.site;
      if (!${unconfirmed}) kwargs.onDelivery({promptHash:createHash('sha256').update(kwargs.prompt).digest('hex'),responseHash:createHash('sha256').update(response).digest('hex'),evidence:'adapter-exact-prompt-pair'});
      return [{response,conversationId:id,conversationUrl:url}];
    }`,
  );
  const envKeys = ["HOME", "OPENCLI_PACKAGE_ROOT", "PI_PAGE_PROVIDER_BRIDGE", "PI_PAGE_PROVIDER_ADAPTER_ROOT"];
  const prior = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.HOME = root;
  process.env.OPENCLI_PACKAGE_ROOT = root;
  delete process.env.PI_PAGE_PROVIDER_BRIDGE;
  delete process.env.PI_PAGE_PROVIDER_ADAPTER_ROOT;
  t.after(() => {
    for (const key of envKeys)
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    rmSync(root, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({
    authPath: join(root, "no-real-auth.json"),
    modelsPath: null,
    modelsStorePath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const manager = SessionManager.create(join(root, "project"), join(root, "native"));
  manager.appendModelChange("opencli-page", "chatgpt-web");
  manager.appendMessage({ role: "system", content: "PRIVATE_PI_SYSTEM", timestamp: 1 });
  if (!fresh) {
    manager.appendMessage({ role: "user", content: "PRIVATE_COLD_OLD_SOURCE", timestamp: 2 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "FICTIONAL_PRESET_NOT_A_MODEL_REPLY" }],
      provider: "fictional",
      api: "openai-completions",
      model: "fake",
      usage,
      stopReason: "stop",
      timestamp: 3,
    });
    const kept = manager.appendMessage({ role: "user", content: "当前计划4箱，尚未执行。", timestamp: 4 });
    manager.appendCompaction("FICTIONAL_WARM 蓝鲸47，蓝色；旧3箱仅是旧计划。", kept, 30);
  }
  const bindings = new ModelSessions();
  const controller = new TieredBudgetController({ automatic });
  const native = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    enableAnalytics: false,
    enableInstallTelemetry: false,
  });
  const services = await createAgentSessionServices({
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
    modelRuntime: runtime,
    settingsManager: native,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPromptOverride: () => "PRIVATE_PI_SYSTEM",
      additionalExtensionPaths: [join(packagePath, "extensions/page-provider.ts")],
      extensionFactories: [
        controller.extension(),
        ...(modelBindings ? [bindings.extension()] : []),
        ...(forceEmptyPrompt
          ? [
              {
                name: "fictional-forced-prompt",
                hidden: true,
                factory(pi) {
                  pi.on("before_agent_start", () => ({ systemPrompt: "" }));
                },
              },
            ]
          : []),
      ],
    },
  });
  const registered = runtime.getRegisteredProviderConfig("opencli-page");
  if (mutateAtDispatch || mutateBeforeReply) {
    const original = registered.streamSimple;
    runtime.registerProvider("opencli-page", {
      ...registered,
      streamSimple: Object.assign(
        (model, context, options) =>
          original(model, context, {
            ...options,
            pageBeforeDispatch: (request) => {
              if (mutateAtDispatch) manager.appendCustomEntry("foreign-metadata", { bad: true });
              options.pageBeforeDispatch(request);
            },
            pageOnReceipt: (receipt, markdown) => {
              if (mutateBeforeReply)
                manager.appendMessage({ role: "user", content: "Late source change", timestamp: 5 });
              options.pageOnReceipt(receipt, markdown);
            },
          }),
        { tieredWebContract: "pi-tiered-web-1" },
      ),
    });
  }
  const { session } = await createAgentSessionFromServices({
    services: { ...services, settingsManager: controller.wrapSettings(native) },
    sessionManager: manager,
    model: runtime.getModel("opencli-page", "chatgpt-web"),
    thinkingLevel: "off",
    tools: [],
  });
  controller.install(session);
  if (modelBindings) bindings.install(session);
  t.after(() => session.dispose());
  if (mutatePayload) {
    const original = session.agent.streamFunction;
    session.agent.streamFunction = (m, c, o) =>
      original(m, c, { ...o, onPayload: (p) => ({ ...p, text: p.text + " MUTATED" }) });
  }
  const notices = [];
  const approvals = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      confirm: async (title, text) => {
        approvals.push({ title, text });
        return title === "Enable experimental session budget?" || accept;
      },
      notify: (text) => notices.push(text),
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
    },
  });
  await session.prompt("/tiered-budget-enable");
  assert.equal(controller.enabled, true, notices.join("\n"));
  return {
    root,
    capture,
    runtime,
    manager,
    session,
    controller,
    approvals,
    readCaptures: () => (existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse) : []),
  };
}
test(
  "fresh Web session accepts the SDK's forced system projection before first JSONL flush",
  { skip: !packagePath },
  async (t) => {
    const f = await fixture(t, { automatic: true, modelBindings: true, fresh: true, forceEmptyPrompt: true });
    await f.session.prompt("Fictional first Web request");
    const captures = f.readCaptures();
    assert.equal(captures.length, 1);
    assert.ok(captures[0].text.includes("Fictional first Web request"));
    assert.ok(!captures[0].text.includes("PRIVATE_PI_SYSTEM"));
  },
);

test(
  "actual SDK + real Page extension + bundled bidirectional bridge: three target wire/receipt/persistence chain",
  { skip: !packagePath },
  async (t) => {
    const f = await fixture(t);
    const before = readFileSync(f.manager.getSessionFile());
    for (const id of ["chatgpt-web", "deepseek-chat", "deepseek-reasoner", "chatgpt-web"]) {
      await f.session.setModel(f.runtime.getModel("opencli-page", id));
      await f.session.prompt("只回答当前计划；不要声称已完成。");
      const last = f.session.messages.at(-1);
      assert.equal(last.stopReason, "stop", last.errorMessage);
      assert.match(f.session.getLastAssistantText(), /FICTIONAL_WEB_REPLY/);
    }
    const calls = f.readCaptures();
    assert.equal(calls.length, 4);
    for (const [index, call] of calls.entries()) {
      assert.match(call.text, /FICTIONAL_WARM/);
      assert.match(call.text, /当前计划4箱/);
      assert.doesNotMatch(call.text, /PRIVATE_COLD|PI TASK HANDOFF/);
      assert.match(call.text, /PRIVATE_PI_SYSTEM/);
      assert.equal(Boolean(call.new), index < 3);
      assert.equal(call.conversation, index < 3 ? undefined : "fictional_remote");
    }
    assert.equal(calls[1].think, false);
    assert.equal(calls[2].think, true);
    const deliveries = f.manager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === "page-provider-tiered-delivery");
    assert.equal(deliveries.length, 4);
    assert.ok(
      deliveries.every(
        (e) => e.data.assistantEntryId && e.data.promptHash && e.data.responseHash && e.data.hotSourceEntryIds.length,
      ),
    );
    assert.equal(
      f.manager.getBranch().filter((e) => e.type === "custom" && e.customType === "page-provider-checkpoint").length,
      0,
    );
    assert.deepEqual(readFileSync(f.manager.getSessionFile()).subarray(0, before.length), before);
    assert.equal(f.approvals.filter((a) => a.title === "Approve this ONE complete Web context?").length, 4);
  },
);
for (const [name, options, count] of [
  ["source rejection sends nothing", { accept: false }, 0],
  ["final text transformation sends nothing", { mutatePayload: true }, 0],
  ["source changed at actual before-submit frame sends nothing", { mutateAtDispatch: true }, 0],
  ["late reply cannot advance successful receipt/cursor", { mutateBeforeReply: true }, 1],
])
  test(name, { skip: !packagePath }, async (t) => {
    const f = await fixture(t, options);
    await f.session.prompt("Fictional current request");
    assert.equal(f.readCaptures().length, count);
    assert.equal(
      f.manager.getBranch().filter((e) => e.type === "custom" && e.customType === "page-provider-tiered-delivery")
        .length,
      0,
    );
    assert.equal(
      f.manager.getBranch().filter((e) => e.type === "custom" && e.customType === "page-provider-checkpoint").length,
      0,
    );
  });

test(
  "Web image batches reuse the new remote session and finish with the final request",
  { skip: !packagePath },
  async (t) => {
    const f = await fixture(t, { modelBindings: true, automatic: true });
    const images = Array.from({ length: 9 }, (_, i) => ({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(`fixture-picture-${i}`).toString("base64"),
    }));
    await f.session.prompt("FINAL_WEB_IMAGE_REQUEST", { images });
    assert.equal(f.session.messages.at(-1).stopReason, "stop", f.session.messages.at(-1).errorMessage);
    const calls = f.readCaptures();
    assert.deepEqual(
      calls.map((c) => c.images),
      [8, 1, 0],
    );
    assert.equal(calls[0].new, true);
    assert.ok(calls.slice(1).every((c) => !c.new && c.conversation === "fictional_remote"));
    assert.doesNotMatch(calls[0].text, /FINAL_WEB_IMAGE_REQUEST/);
    assert.match(calls.at(-1).text, /FINAL_WEB_IMAGE_REQUEST/);
  },
);

test(
  "unconfirmed Web images never advance the delivered cursor or submit another batch",
  { skip: !packagePath },
  async (t) => {
    const f = await fixture(t, { modelBindings: true, automatic: true, unconfirmed: true, fresh: true });
    const images = Array.from({ length: 9 }, (_, i) => ({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(`unconfirmed-image-${i}`).toString("base64"),
    }));
    await assert.rejects(f.session.prompt("Final request", { images }), /delivery is unconfirmed/);
    assert.equal(f.readCaptures().length, 1);
    const saved = f.manager
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === "desktop-model-sessions")
      .at(-1).data;
    assert.ok(saved.records.every((record) => record.delivered.length === 0));
  },
);
