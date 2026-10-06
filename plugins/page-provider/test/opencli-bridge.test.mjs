import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bridge = fileURLToPath(new URL("../bridge/opencli-bridge.mjs", import.meta.url));

async function fakeOpenCli(executionSource) {
  const root = await mkdtemp(join(tmpdir(), "pi-fake-opencli-"));
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await mkdir(join(root, "clis", "deepseek"), { recursive: true });
  await mkdir(join(root, "clis", "chatgpt"), { recursive: true });
  await writeFile(
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
  await writeFile(
    join(root, "dist", "src", "registry-api.js"),
    "export const cli = c => c; export const Strategy = {COOKIE:'cookie'};",
  );
  await writeFile(
    join(root, "dist", "src", "errors.js"),
    "export class CliError extends Error {} export class ArgumentError extends CliError {} export class CommandExecutionError extends CliError {} export class TimeoutError extends CliError {} export class AuthRequiredError extends CliError {} export const EXIT_CODES={};",
  );
  await writeFile(join(root, "dist", "src", "utils.js"), "export const htmlToMarkdown=s=>s;");
  await writeFile(join(root, "dist", "src", "execution.js"), executionSource, "utf8");
  await writeFile(
    join(root, "clis", "deepseek", "ask.js"),
    "export const askCommand = { site: 'deepseek', name: 'ask' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "deepseek", "status.js"),
    "export const statusCommand = { site: 'deepseek', name: 'status' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "deepseek", "detail.js"),
    "export const detailCommand = { site: 'deepseek', name: 'detail' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "deepseek", "new.js"),
    "export const newCommand = { site: 'deepseek', name: 'new' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "chatgpt", "ask.js"),
    "export const askCommand = { site: 'chatgpt', name: 'ask' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "chatgpt", "status.js"),
    "export const statusCommand = { site: 'chatgpt', name: 'status' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "chatgpt", "detail.js"),
    "export const detailCommand = { site: 'chatgpt', name: 'detail' };\n",
    "utf8",
  );
  await writeFile(
    join(root, "clis", "chatgpt", "new.js"),
    "export const newCommand = { site: 'chatgpt', name: 'new' };\n",
    "utf8",
  );
  return root;
}

function runBridge({ root, request, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: join(root, "home"),
        OPENCLI_PACKAGE_ROOT: root,
        PI_PAGE_PROVIDER_SITE: "deepseek",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stderr,
        events: stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

test("OpenCLI bridge executes the built-in adapter with the external runtime and normalizes Markdown", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs, debug, options) {
  if (process.argv.includes(kwargs.prompt)) throw new Error("prompt leaked into argv");
  if (command.site !== "deepseek" || kwargs.think !== false || debug !== false || options.siteSession !== "persistent") {
    throw new Error("unexpected execution contract");
  }
  return [{ response: "# DeepSeek\\n\\n" + kwargs.prompt }];
}
`);
  const result = await runBridge({
    root,
    request: { id: "turn-1", method: "turn.send", params: { text: "private prompt" } },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["provider.state", "provider.state", "turn.status", "turn.completed"],
  );
  assert.equal(result.events.at(-1).message.markdown, "# DeepSeek\n\nprivate prompt");
  assert.equal(result.events.at(-1).remote.site, "deepseek");
});

test("OpenCLI bridge routes each request to its requested site adapter", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.site !== "chatgpt" || "think" in kwargs) throw new Error("wrong site routing");
  return [{
    response: command.site + ":" + kwargs.prompt,
    conversationId: "remote_chat_123",
    conversationUrl: "https://chatgpt.com/c/remote_chat_123"
  }];
}
`);
  const result = await runBridge({
    root,
    request: {
      id: "turn-chatgpt",
      method: "turn.send",
      params: { text: "hello", site: "chatgpt", mode: "chat" },
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.events.at(-1).message.markdown, "chatgpt:hello");
  assert.deepEqual(result.events.at(-1).remote, {
    site: "chatgpt",
    mode: "chat",
    conversationId: "remote_chat_123",
    conversationUrl: "https://chatgpt.com/c/remote_chat_123",
  });
});

test("OpenCLI bridge drops off-site remote conversation URLs", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand() {
  return [{
    response: "safe response",
    conversationId: "remote_123",
    conversationUrl: "https://evil.example/steal"
  }];
}
`);
  const result = await runBridge({
    root,
    request: {
      id: "turn-offsite",
      method: "turn.send",
      params: { text: "hello", site: "chatgpt", mode: "chat" },
    },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(result.events.at(-1).remote, {
    site: "chatgpt",
    mode: "chat",
    conversationId: "remote_123",
  });
});

test("OpenCLI bridge enables adapter deduplication for failed-turn retries", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.site !== "chatgpt" || kwargs.dedupe !== true) throw new Error("handoff dedupe missing");
  return [{ response: "PI_HANDOFF_ACK task=task-1 checkpoint=1\\ncontinued" }];
}
`);
  const result = await runBridge({
    root,
    request: {
      id: "turn-handoff-retry",
      method: "turn.send",
      params: {
        text: "retry this completed turn",
        site: "chatgpt",
        mode: "chat",
        dedupe: true,
      },
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.events.at(-1).type, "turn.completed");
});

test("OpenCLI bridge maps reasoner mode to the DeepSeek think flag", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.name !== "ask" || kwargs.think !== true) throw new Error("reasoner mode missing");
  return [{ response: "reasoner:" + kwargs.prompt }];
}
`);
  const result = await runBridge({
    root,
    request: {
      id: "turn-reasoner",
      method: "turn.send",
      params: { text: "solve", mode: "reasoner" },
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.events.at(-1).message.markdown, "reasoner:solve");
  assert.equal(result.events.at(-1).remote.mode, "reasoner");
});

test("OpenCLI bridge materializes multiple inline images for one adapter call", async () => {
  const root = await fakeOpenCli(`
import { readFileSync } from "node:fs";
export async function executeCommand(command, kwargs) {
  if (command.name !== "ask" || !Array.isArray(kwargs.file) || kwargs.file.length !== 2) {
    throw new Error("missing image files");
  }
  const hex = kwargs.file.map((file) => readFileSync(file).toString("hex")).join(",");
  return [{ response: kwargs.prompt + ":" + hex }];
}
`);
  const result = await runBridge({
    root,
    request: {
      id: "turn-image",
      method: "turn.send",
      params: {
        text: "image",
        attachments: [
          { kind: "image", mimeType: "image/png", data: "AQI=" },
          { kind: "image", mimeType: "image/jpeg", data: "AwQ=" },
        ],
      },
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.events.at(-1).message.markdown, "image:0102,0304");
});

test("OpenCLI bridge uses its built-in adapter even with a stale user override", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.source === 'private') throw new Error('stale override loaded');
  if (command.pageProviderDispatchContract !== 'pi-tiered-web-1') throw new Error('missing built-in contract');
  return [{ response: "builtin:" + kwargs.prompt }];
}
`);
  const home = join(root, "override-home");
  const overrideDir = join(home, ".opencli", "clis", "deepseek");
  await mkdir(overrideDir, { recursive: true });
  await writeFile(
    join(overrideDir, "ask.js"),
    "export const askCommand = { site: 'deepseek', name: 'ask', source: 'private' };\n",
    "utf8",
  );
  const result = await runBridge({
    root,
    env: { HOME: home },
    request: { id: "turn-private", method: "turn.send", params: { text: "hello" } },
  });

  assert.equal(result.code, 0);
  assert.equal(result.events.at(-1).message.markdown, "builtin:hello");
});

test("OpenCLI bridge routes new and bound turns explicitly", async () => {
  const id = "749e6bbd-6a45-4440-beaa-ae5238bf06d8";
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.name === "new") {
    if (Object.keys(kwargs).length !== 0) throw new Error("new received arguments");
    return [{ Status: "New chat started" }];
  }
  if (command.name !== "ask" || kwargs.new !== true || kwargs.conversation !== undefined) {
    throw new Error("new turn was not routed explicitly");
  }
  await kwargs.onConversation({
    conversationId: ${JSON.stringify("749e6bbd-6a45-4440-beaa-ae5238bf06d8")},
    conversationUrl: ${JSON.stringify("https://chat.deepseek.com/a/chat/s/749e6bbd-6a45-4440-beaa-ae5238bf06d8")},
  });
  return [{ response: "fresh", conversationId: ${JSON.stringify("749e6bbd-6a45-4440-beaa-ae5238bf06d8")}, conversationUrl: ${JSON.stringify("https://chat.deepseek.com/a/chat/s/749e6bbd-6a45-4440-beaa-ae5238bf06d8")} }];
}
`);
  const started = await runBridge({
    root,
    request: { id: "new-1", method: "provider.new", params: { site: "deepseek" } },
  });
  assert.equal(started.code, 0);
  assert.deepEqual(started.events.at(-1), {
    type: "provider.started",
    id: "new-1",
    provider: { site: "deepseek" },
  });

  const turn = await runBridge({
    root,
    request: {
      id: "turn-new",
      method: "turn.send",
      params: { site: "deepseek", text: "hello", newConversation: true },
    },
  });
  assert.equal(turn.code, 0);
  assert.deepEqual(
    turn.events.map((event) => event.type),
    ["provider.state", "provider.state", "turn.status", "turn.remote", "turn.completed"],
  );
  assert.equal(turn.events[3].remote.conversationId, id);
  assert.equal(turn.events.at(-1).message.markdown, "fresh");

  const boundRoot = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.name !== "ask" || kwargs.conversation !== ${JSON.stringify("749e6bbd-6a45-4440-beaa-ae5238bf06d8")} || kwargs.new !== undefined) {
    throw new Error("bound turn was not routed explicitly");
  }
  return [{ response: "bound" }];
}
`);
  const bound = await runBridge({
    root: boundRoot,
    request: {
      id: "turn-bound",
      method: "turn.send",
      params: { site: "deepseek", text: "continue", conversationId: id },
    },
  });
  assert.equal(bound.code, 0);
  assert.equal(bound.events.at(-1).message.markdown, "bound");
});

test("OpenCLI bridge opens an exact bound conversation through the detail adapter", async () => {
  const id = "749e6bbd-6a45-4440-beaa-ae5238bf06d8";
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs, debug, options) {
  if (command.name !== "detail" || kwargs.id !== ${JSON.stringify("749e6bbd-6a45-4440-beaa-ae5238bf06d8")}) {
    throw new Error("unexpected open contract");
  }
  if (debug !== false || options.siteSession !== "persistent") throw new Error("wrong execution options");
  return [{ Index: 1, Role: "Assistant", Text: "bound" }];
}
`);
  const result = await runBridge({
    root,
    request: {
      id: "open-1",
      method: "provider.open",
      params: { site: "deepseek", conversationId: id },
    },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(result.events.at(-1), {
    type: "provider.opened",
    id: "open-1",
    provider: { site: "deepseek", conversationId: id },
  });
});

test("OpenCLI bridge probes page readiness without sending a model turn", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  if (command.name !== "status" || Object.keys(kwargs).length !== 0) {
    throw new Error("probe dispatched the wrong command");
  }
  return [{ Status: "Connected", Login: "Yes", Url: "https://chat.deepseek.com/" }];
}
`);
  const result = await runBridge({
    root,
    request: { id: "probe-1", method: "provider.probe", params: {} },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["provider.state", "provider.state", "provider.probed"],
  );
  assert.equal(result.events[1].state, "ready");
  assert.equal(result.events[1].provider.authenticated, true);
});

test("OpenCLI bridge maps authentication failures without exposing raw details", async () => {
  const root = await fakeOpenCli(`
export async function executeCommand() {
  const error = new Error("Login with secret account user@example.test");
  error.code = "AUTH_REQUIRED";
  throw error;
}
`);
  const result = await runBridge({
    root,
    request: { id: "turn-2", method: "turn.send", params: { text: "hello" } },
  });

  assert.equal(result.code, 1);
  const failure = result.events.at(-1);
  assert.equal(failure.type, "turn.failed");
  assert.equal(failure.error.code, "LOGIN_REQUIRED");
  assert.doesNotMatch(failure.error.message, /user@example|secret account/);
});

test("OpenCLI bridge serializes concurrent turns for the same site across processes", async () => {
  const root = await fakeOpenCli(`
import { appendFile } from "node:fs/promises";
export async function executeCommand(command, kwargs) {
  await appendFile(process.env.PP_CONCURRENCY_LOG, "start:" + kwargs.prompt + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await appendFile(process.env.PP_CONCURRENCY_LOG, "end:" + kwargs.prompt + "\\n");
  return [{ response: "ok", conversationId: kwargs.prompt, conversationUrl: "https://chat.deepseek.com/a/chat/s/8de23747-142b-4c91-80ba-fe4f3865d22f" }];
}
`);
  const logPath = join(root, "concurrency.log");
  const env = { PP_CONCURRENCY_LOG: logPath };
  const [first, second] = await Promise.all([
    runBridge({ root, env, request: { id: "concurrent-a", method: "turn.send", params: { text: "first" } } }),
    runBridge({ root, env, request: { id: "concurrent-b", method: "turn.send", params: { text: "second" } } }),
  ]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.match(lines[0], /^start:(first|second)$/);
  assert.equal(lines[1], lines[0].replace("start:", "end:"));
  assert.match(lines[2], /^start:(first|second)$/);
  assert.equal(lines[3], lines[2].replace("start:", "end:"));
  assert.notEqual(lines[0], lines[2]);
});

test("OpenCLI bridge reports distinct send, discovery, completion, and extraction stages", async () => {
  const cases = [
    {
      source: `throw Object.assign(new Error("composer unavailable"), { code: "COMPOSER_NOT_FOUND" });`,
      code: "PAGE_PROVIDER_SEND_FAILED",
    },
    {
      source: `throw Object.assign(new Error("timed out before conversation URL"), { code: "TIMEOUT" });`,
      code: "PAGE_PROVIDER_CONVERSATION_DISCOVERY_FAILED",
    },
    {
      source: `
        await kwargs.onConversation({
          conversationId: "8de23747-142b-4c91-80ba-fe4f3865d22f",
          conversationUrl: "https://chat.deepseek.com/a/chat/s/8de23747-142b-4c91-80ba-fe4f3865d22f",
        });
        throw Object.assign(new Error("reply timed out"), { code: "TIMEOUT" });
      `,
      code: "PAGE_PROVIDER_COMPLETION_TIMEOUT",
    },
    {
      source: `return [{}];`,
      code: "PAGE_PROVIDER_EXTRACTION_FAILED",
    },
  ];

  for (const scenario of cases) {
    const root = await fakeOpenCli(`
export async function executeCommand(command, kwargs) {
  ${scenario.source}
}
`);
    const result = await runBridge({
      root,
      request: { id: `stage-${scenario.code}`, method: "turn.send", params: { text: "hello" } },
    });
    assert.equal(result.code, 1);
    assert.equal(result.events.at(-1).type, "turn.failed");
    assert.equal(result.events.at(-1).error.code, scenario.code);
  }
});

test("OpenCLI bridge rejects unsupported site profiles before loading an adapter", async () => {
  const root = await fakeOpenCli("export async function executeCommand() { return []; }\n");
  const result = await runBridge({
    root,
    env: { PI_PAGE_PROVIDER_SITE: "unknown" },
    request: { id: "turn-3", method: "turn.send", params: { text: "hello" } },
  });

  assert.equal(result.code, 1);
  assert.equal(result.events.at(-1).type, "turn.failed");
  assert.equal(result.events.at(-1).error.code, "OPENCLI_ERROR");
  assert.doesNotMatch(result.events.at(-1).error.message, /unknown/);
});
