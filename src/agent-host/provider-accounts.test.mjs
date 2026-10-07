import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importTestBundle } from "#test-bundle";
import { ModelRuntime, createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { ModelSessions } from "./memory/model-sessions.mjs";
const { ProviderAccounts } = await importTestBundle("provider-accounts", {
  packages: "external",
  absWorkingDir: path.resolve(import.meta.dirname, "../.."),
  entryPoints: [path.join(import.meta.dirname, "provider-accounts.ts")],
});
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-accounts-isolated-"));
  const agent = path.join(root, "agent");
  mkdirSync(agent);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { agent, accounts: new ProviderAccounts(agent) };
}
test("two account credentials are isolated, metadata is secret-free, defaults and names survive restart", async (t) => {
  const { agent, accounts } = fixture(t);
  const a = accounts.add("anthropic-api", "A"),
    b = accounts.add("anthropic-api", "B");
  const login = (account, key) => accounts.login(account.provider, "api_key", { prompt: async () => key, notify() {} });
  await login(a, "fictional-account-A-secret");
  await login(b, "fictional-account-B-secret");
  assert.notEqual(a.provider, b.provider);
  assert.equal((await accounts.runtime(a)).getProviderAuthStatus("anthropic").configured, true);
  assert.equal((await accounts.runtime(b)).getProviderAuthStatus("anthropic").configured, true);
  assert.match(readFileSync(path.join(agent, "accounts", a.id, "auth.json"), "utf8"), /fictional-account-A-secret/);
  assert.doesNotMatch(
    readFileSync(path.join(agent, "accounts", a.id, "auth.json"), "utf8"),
    /fictional-account-B-secret/,
  );
  assert.equal(statSync(path.join(agent, "accounts", a.id, "auth.json")).mode & 0o777, 0o600);
  accounts.update(b.id, "default");
  accounts.update(a.id, "rename", "Renamed A");
  const restored = new ProviderAccounts(agent);
  assert.equal(restored.list().find((row) => row.id === b.id).isDefault, true);
  assert.equal(restored.list().find((row) => row.id === a.id).name, "Renamed A");
  assert.equal(restored.defaultProvider(a.provider), b.provider);
  assert.doesNotMatch(JSON.stringify(await restored.status()), /fictional-account|secret/);
  assert.doesNotMatch(readFileSync(path.join(agent, "provider-accounts.json"), "utf8"), /fictional-account|secret/);
});
test("legacy subscription/API migration is idempotent and leaves original auth and JSONL byte-identical", async (t) => {
  const { agent, accounts } = fixture(t);
  const auth = JSON.stringify({
    "openai-codex": { type: "oauth", access: "fictional-access", refresh: "fictional-refresh", expires: 1 },
    anthropic: { type: "api_key", key: "fictional-api" },
    deepseek: { type: "api_key", key: "fictional-flash" },
  });
  writeFileSync(path.join(agent, "auth.json"), auth);
  writeFileSync(path.join(agent, "original.jsonl"), "fictional image and tool transcript\n");
  assert.equal(accounts.list().length, 2);
  const restored = new ProviderAccounts(agent);
  assert.equal(restored.list().length, 2);
  assert.deepEqual(
    restored.list().map((row) => row.provider),
    ["openai-codex", "anthropic"],
  );
  assert.equal(readFileSync(path.join(agent, "auth.json"), "utf8"), auth);
  assert.equal(readFileSync(path.join(agent, "original.jsonl"), "utf8"), "fictional image and tool transcript\n");
  assert.equal(
    (await restored.status()).every((row) => row.loggedIn),
    true,
  );
});
test("missing credentials cannot use ambient credentials; removal retains identity and blocks old bindings", async (t) => {
  const { agent, accounts } = fixture(t);
  const a = accounts.add("anthropic-api", "A");
  const runtime = await ModelRuntime.create({
    authPath: path.join(agent, "empty-auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  await accounts.install(runtime);
  assert.equal(await runtime.checkAuth(a.provider), undefined);
  await assert.rejects(runtime.getAuth(a.provider), /signed out|removed/);
  const release = accounts.acquire(a.provider);
  await assert.rejects(accounts.remove(a.id), /current requests/);
  await assert.rejects(accounts.logout(a.provider), /current requests/);
  release();
  await accounts.login(a.provider, "api_key", { prompt: async () => "fictional-key", notify() {} });
  await accounts.remove(a.id);
  assert.equal(existsSync(path.join(agent, "accounts", a.id, "auth.json")), false);
  assert.equal(new ProviderAccounts(agent).find(a.provider).removed, true);
  assert.equal(new ProviderAccounts(agent).list().length, 0);
  await assert.rejects(runtime.getAuth(a.provider), /signed out|removed/);
  assert.throws(() => accounts.acquire(a.provider), /removed/);
});
test("authentication in progress prevents sending/removal, and invalid types never create CC impostors", async (t) => {
  const { accounts } = fixture(t);
  assert.throws(() => accounts.add("claude-code", "CC"), /Claude Code/);
  const a = accounts.add("anthropic-api", "A");
  let resolve, started;
  const ready = new Promise((r) => (started = r));
  const login = accounts.login(a.provider, "api_key", {
    prompt: () => {
      started();
      return new Promise((r) => (resolve = r));
    },
    notify() {},
  });
  await ready;
  assert.throws(() => accounts.acquire(a.provider), /authentication/);
  await assert.rejects(accounts.remove(a.id), /current requests/);
  resolve("fictional-auth");
  await login;
  const release = accounts.acquire(a.provider);
  release();
});
test("Pi+provider/account+model A-B-A IDs persist and same-name models never share", async () => {
  const entries = [];
  const manager = {
    getEntries: () => entries,
    getSessionId: () => "pi-conversation",
    appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  const bindings = new ModelSessions();
  bindings.session = { sessionId: "pi-conversation", sessionManager: manager };
  const a = { provider: "account-A", id: "same-model" },
    b = { provider: "account-B", id: "same-model" };
  const aId = bindings.select(a).id;
  const bId = bindings.select(b).id;
  assert.notEqual(aId, bId);
  assert.equal(bindings.select(a).id, aId);
  const restored = new ModelSessions();
  restored.restore(manager);
  restored.session = bindings.session;
  assert.equal(restored.select(b).id, bId);
  assert.equal(restored.select(a).id, aId);
});

test("migrated Codex remains usable through SDK auth, and two Codex accounts resolve only their own tokens", async (t) => {
  const { agent, accounts } = fixture(t);
  const valid = {
    type: "oauth",
    access: "fictional-old-codex",
    refresh: "fictional-refresh",
    expires: Date.now() + 3600000,
  };
  writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ "openai-codex": valid }));
  const old = accounts.list()[0];
  const b = accounts.add("codex", "B");
  writeFileSync(
    path.join(agent, "accounts", b.id, "auth.json"),
    JSON.stringify({ "openai-codex": { ...valid, access: "fictional-B-codex" } }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agent, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  await accounts.install(runtime);
  assert.equal((await runtime.getAuth(old.provider)).auth.apiKey, "fictional-old-codex");
  assert.equal((await runtime.getAuth(b.provider)).auth.apiKey, "fictional-B-codex");
  assert.equal((await runtime.getAuth(old.provider)).auth.apiKey, "fictional-old-codex");
  const scoped = await accounts.runtime(old);
  const native = scoped.getProvider("openai-codex");
  scoped.registerNativeProvider({
    ...native,
    auth: {
      oauth: {
        ...native.auth.oauth,
        refresh: async () => {
          throw new Error("fictional-private-refresh-error");
        },
      },
    },
  });
  writeFileSync(
    path.join(agent, "accounts", old.id, "auth.json"),
    JSON.stringify({ "openai-codex": { ...valid, expires: 1 } }),
  );
  await assert.rejects(runtime.getAuth(old.provider), (error) => {
    assert.match(error.message, /OAuth|expired|refresh/);
    assert.doesNotMatch(error.message + String(error.cause), /fictional-private-refresh-error/);
    return true;
  });
  assert.equal((await runtime.getAuth(b.provider)).auth.apiKey, "fictional-B-codex");
  await accounts.remove(old.id);
  assert.equal(JSON.parse(readFileSync(path.join(agent, "auth.json"), "utf8"))["openai-codex"], undefined);
  await assert.rejects(runtime.getAuth(old.provider), /removed|signed out/);
  assert.equal((await runtime.getAuth(b.provider)).auth.apiKey, "fictional-B-codex");
});

test("real local Anthropic SDK requests transfer text/original image A-B-A, preserve identities and refuse switching/removal mid-request", async (t) => {
  const { agent, accounts } = fixture(t);
  const a = accounts.add("anthropic-api", "A"),
    b = accounts.add("anthropic-api", "B");
  const captures = [];
  let waitForRequest,
    releaseResponse,
    block = false,
    status = 200;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const owner =
      request.headers["x-api-key"] === "fictional-A-key"
        ? "A"
        : request.headers["x-api-key"] === "fictional-B-key"
          ? "B"
          : "unknown";
    captures.push({ owner, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: status === 401 ? "authentication_error" : "rate_limit_error",
            message: "fictional-do-not-display-secret",
          },
        }),
      );
      return;
    }
    if (block) {
      waitForRequest();
      await new Promise((resolve) => (releaseResponse = resolve));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const data of [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "claude-fixture",
          content: [],
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FICTIONAL_REPLY" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ])
      response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    releaseResponse?.();
    server.closeAllConnections();
    server.close();
  });
  for (const account of [a, b]) {
    writeFileSync(
      path.join(agent, "accounts", account.id, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            api: "anthropic-messages",
            models: [
              {
                id: "claude-fixture",
                name: "Fixture",
                input: ["text", "image"],
                contextWindow: 20000,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    await accounts.login(account.provider, "api_key", {
      prompt: async () => `fictional-${account.name}-key`,
      notify() {},
    });
  }
  const runtime = await ModelRuntime.create({
    authPath: path.join(agent, "empty.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  await accounts.install(runtime);
  const { session } = await createAgentSession({
    cwd: agent,
    agentDir: agent,
    modelRuntime: runtime,
    model: runtime.getModel(a.provider, "claude-fixture"),
    sessionManager: SessionManager.inMemory(agent),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    noTools: true,
  });
  t.after(() => session.dispose());
  const bindings = new ModelSessions({ acquire: (provider) => accounts.acquire(provider) });
  bindings.install(session);
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYxoAAAAASUVORK5CYII=",
  };
  await session.prompt("Remember ORIGINAL_A_FACT", { images: [image] });
  const aId = bindings.currentId();
  await session.setModel(runtime.getModel(b.provider, "claude-fixture"));
  await session.prompt("B should see ORIGINAL_A_FACT and original image");
  const bId = bindings.currentId();
  await session.setModel(runtime.getModel(a.provider, "claude-fixture"));
  await session.prompt("A again CURRENT_REQUEST");
  assert.notEqual(aId, bId);
  assert.equal(bindings.currentId(), aId);
  assert.deepEqual(
    captures.map((row) => row.owner),
    ["A", "B", "A"],
  );
  assert.match(JSON.stringify(captures[1].body), /ORIGINAL_A_FACT/);
  assert.ok(JSON.stringify(captures[1].body).includes(image.data));
  assert.match(JSON.stringify(captures[2].body), /CURRENT_REQUEST/);
  assert.equal(session.messages.filter((message) => message.role === "assistant").at(-1).provider, a.provider);
  block = true;
  const ready = new Promise((resolve) => (waitForRequest = resolve));
  const running = session.prompt("IN_FLIGHT");
  await ready;
  await assert.rejects(session.setModel(runtime.getModel(b.provider, "claude-fixture")), /current request/);
  await assert.rejects(accounts.remove(a.id), /current requests/);
  releaseResponse();
  await running;
  assert.equal(bindings.currentId(), aId);
  block = false;
  for (const code of [401, 429]) {
    status = code;
    const result = await runtime.completeSimple(
      runtime.getModel(a.provider, "claude-fixture"),
      { messages: [{ role: "user", content: "Fictional error", timestamp: 1 }] },
      { maxRetries: 0 },
    );
    assert.equal(result.stopReason, "error");
    assert.equal(result.provider, a.provider);
    assert.match(result.errorMessage, code === 401 ? /invalid or expired/ : /quota or rate limit/);
    assert.doesNotMatch(JSON.stringify(result), /fictional-do-not-display-secret/);
    assert.equal(captures.at(-1).owner, "A");
  }
});
