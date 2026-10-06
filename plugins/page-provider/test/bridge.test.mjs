import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assistantMessage,
  latestUserInput,
  latestUserText,
  openPageProviderConversation,
  pageProviderWorkingMessage,
  probePageProvider,
  runPageProviderTurn,
  startNewPageProviderConversation,
} from "../src/bridge.mjs";

async function fakeBridge(source) {
  const root = await mkdtemp(join(tmpdir(), "pi-page-provider-"));
  const file = join(root, "bridge.mjs");
  await writeFile(file, source, "utf8");
  return file;
}

test("latestUserText returns the latest non-empty user text", () => {
  assert.equal(
    latestUserText({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "second" },
            { type: "text", text: "line" },
          ],
        },
      ],
    }),
    "second\nline",
  );
});

test("latestUserInput preserves text and images from the latest user message", () => {
  assert.deepEqual(
    latestUserInput({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", mimeType: "image/png", data: "AQI=" },
            { type: "image", mimeType: "image/jpeg", data: "AwQ=" },
          ],
        },
      ],
    }),
    {
      text: "describe",
      images: [
        { mimeType: "image/png", data: "AQI=" },
        { mimeType: "image/jpeg", data: "AwQ=" },
      ],
    },
  );
});

test("page provider lifecycle states map to native working messages", () => {
  assert.equal(pageProviderWorkingMessage("attaching"), "Connecting to the OpenCLI page…");
  assert.equal(pageProviderWorkingMessage("streaming"), "Receiving the web response…");
  assert.equal(pageProviderWorkingMessage("unknown"), "Waiting for the web model…");
});

test("runPageProviderTurn sends one NDJSON request and accepts lifecycle events", async () => {
  const bridge = await fakeBridge(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input.trim());
  if (request.params.dedupe !== true) process.exit(8);
  process.stdout.write(JSON.stringify({ type: "provider.state", state: "ready" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.status", status: "waiting" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.delta", markdown: "partial" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.remote",
    remote: {
      site: "deepseek",
      mode: "reasoner",
      conversationId: "remote-1",
      conversationUrl: "https://chat.deepseek.com/a/chat/s/remote-1"
    }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    message: { markdown: "# Reply\\n\\n" + request.params.site + ":" + request.params.mode + ":" + request.params.text },
    remote: { conversationId: "remote-1" }
  }) + "\\n");
});
`);
  const states = [];
  const remotes = [];
  const result = await runPageProviderTurn({
    text: "hello",
    mode: "reasoner",
    dedupe: true,
    command: process.execPath,
    args: [bridge],
    onState: (state) => states.push(state),
    onRemote: (remote) => remotes.push(remote),
    timeoutMs: 2_000,
  });

  assert.equal(result.markdown, "# Reply\n\ndeepseek:reasoner:hello");
  assert.equal(result.remote.conversationId, "remote-1");
  assert.equal(remotes[0].conversationId, "remote-1");
  assert.deepEqual(states, ["sending", "ready", "waiting", "streaming", "completed"]);

  await assert.rejects(
    runPageProviderTurn({
      text: "hello",
      conversationId: "remote-1",
      newConversation: true,
    }),
    /cannot create and resume/,
  );
});

test("runPageProviderTurn rejects an unsupported model mode before spawning", async () => {
  await assert.rejects(runPageProviderTurn({ text: "hello", mode: "unknown" }), /Unsupported Page Provider mode/);
});

test("runPageProviderTurn sends inline images without putting them in argv", async () => {
  const bridge = await fakeBridge(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input.trim());
  const attachments = request.params.attachments;
  if (attachments.some((attachment) => process.argv.includes(attachment.data))) process.exit(9);
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    message: { markdown: attachments.map((item) => item.mimeType + ":" + item.data).join(",") }
  }) + "\\n");
});
`);
  const result = await runPageProviderTurn({
    text: "describe",
    images: [
      { mimeType: "image/png", data: "AQI=" },
      { mimeType: "image/jpeg", data: "AwQ=" },
    ],
    command: process.execPath,
    args: [bridge],
    timeoutMs: 2_000,
  });

  assert.equal(result.markdown, "image/png:AQI=,image/jpeg:AwQ=");
});

test("runPageProviderTurn rejects malformed base64 before spawning", async () => {
  let spawned = false;
  await assert.rejects(
    runPageProviderTurn({
      images: [{ mimeType: "image/png", data: "not base64!" }],
      spawn() {
        spawned = true;
        throw new Error("must not spawn");
      },
    }),
    /canonical base64/,
  );
  assert.equal(spawned, false);
});

test("runPageProviderTurn rejects terminal events for another request", async () => {
  const bridge = await fakeBridge(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    turnId: "different-request",
    message: { markdown: "wrong result" }
  }) + "\\n");
});
`);

  await assert.rejects(
    runPageProviderTurn({ text: "hello", command: process.execPath, args: [bridge], timeoutMs: 2_000 }),
    /another request/,
  );
});

test("runPageProviderTurn terminates a bridge after its terminal event", async () => {
  const bridge = await fakeBridge(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    message: { markdown: "done" }
  }) + "\\n");
  setInterval(() => {}, 1000);
});
`);

  const result = await runPageProviderTurn({
    text: "hello",
    command: process.execPath,
    args: [bridge],
    timeoutMs: 2_000,
  });
  assert.equal(result.markdown, "done");
});

test("openPageProviderConversation opens one validated remote conversation", async () => {
  const bridge = await fakeBridge(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({ type: "provider.state", state: "ready" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "provider.opened",
    id: request.id,
    provider: {
      site: request.params.site,
      conversationId: request.params.conversationId
    }
  }) + "\\n");
});
`);
  const result = await openPageProviderConversation({
    site: "deepseek",
    conversationId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
    command: process.execPath,
    args: [bridge],
    timeoutMs: 2_000,
  });

  assert.deepEqual(result, {
    site: "deepseek",
    conversationId: "749e6bbd-6a45-4440-beaa-ae5238bf06d8",
  });
  await assert.rejects(
    openPageProviderConversation({ site: "deepseek", conversationId: "../../etc/passwd" }),
    /valid remote conversation ID/,
  );
});

test("startNewPageProviderConversation starts a fresh site conversation", async () => {
  const bridge = await fakeBridge(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({
    type: "provider.started",
    id: request.id,
    provider: { site: request.params.site }
  }) + "\\n");
});
`);
  const result = await startNewPageProviderConversation({
    site: "chatgpt",
    command: process.execPath,
    args: [bridge],
    timeoutMs: 2_000,
  });

  assert.deepEqual(result, { site: "chatgpt" });
});

test("probePageProvider returns the live readiness state", async () => {
  const bridge = await fakeBridge(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input.trim());
  if (request.method !== "provider.probe") process.exit(8);
  process.stdout.write(JSON.stringify({ type: "provider.state", state: "ready" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "provider.probed", id: request.id, state: "ready" }) + "\\n");
});
`);
  const states = [];
  const result = await probePageProvider({
    command: process.execPath,
    args: [bridge],
    onState: (state) => states.push(state),
    timeoutMs: 2_000,
  });

  assert.equal(result.state, "ready");
  assert.deepEqual(states, ["attaching", "ready"]);
});

test("runPageProviderTurn rejects malformed bridge output", async () => {
  const bridge = await fakeBridge(`process.stdout.write("not-json\\n");`);
  await assert.rejects(
    runPageProviderTurn({
      text: "hello",
      command: process.execPath,
      args: [bridge],
      timeoutMs: 2_000,
    }),
    /invalid JSON/,
  );
});

test("runPageProviderTurn exposes typed bridge failures as lifecycle state", async () => {
  const bridge = await fakeBridge(`
process.stdout.write(JSON.stringify({
  type: "turn.failed",
  error: { code: "LOGIN_REQUIRED", message: "Sign in first" }
}) + "\\n");
`);
  const states = [];
  await assert.rejects(
    runPageProviderTurn({
      text: "hello",
      command: process.execPath,
      args: [bridge],
      onState: (state) => states.push(state),
      timeoutMs: 2_000,
    }),
    /LOGIN_REQUIRED/,
  );
  assert.deepEqual(states, ["sending", "loginRequired"]);
});

test("runPageProviderTurn never copies bridge stderr into its error", async () => {
  const bridge = await fakeBridge(`
process.stderr.write("private prompt or browser data");
process.exitCode = 9;
`);
  await assert.rejects(
    runPageProviderTurn({
      text: "hello",
      command: process.execPath,
      args: [bridge],
      timeoutMs: 2_000,
    }),
    (error) => {
      assert.match(error.message, /code 9/);
      assert.doesNotMatch(error.message, /private prompt|browser data/);
      return true;
    },
  );
});

test("runPageProviderTurn propagates cancellation", async () => {
  const bridge = await fakeBridge(`setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const result = runPageProviderTurn({
    text: "hello",
    command: process.execPath,
    args: [bridge],
    signal: controller.signal,
    timeoutMs: 2_000,
  });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
});

test("assistantMessage maps Markdown into a native PI assistant message", () => {
  const message = assistantMessage(
    { api: "openai-completions", provider: "extension-agent:test", id: "current-page" },
    "**done**",
  );
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [{ type: "text", text: "**done**" }]);
  assert.equal(message.provider, "extension-agent:test");
  assert.equal(message.model, "current-page");
  assert.equal(message.stopReason, "stop");
});
