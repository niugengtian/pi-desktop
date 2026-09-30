import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { installMemoryRequestGuard } from "./request-guard.ts";
const model = { api: "fixture", provider: "fixture", id: "model" };
const originalContext = { systemPrompt: "private original", messages: [] };
const approvedContext = {
  systemPrompt: "minimal approved",
  messages: [{ role: "user", content: "approved snapshot" }],
};
const output = {
  role: "assistant",
  content: [{ type: "text", text: "fictional result" }],
  api: "fixture",
  provider: "fixture",
  model: "model",
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

test("the actual runtime dispatch receives only the prepared context, preserving provider events", async () => {
  let forwarded,
    delivered = 0;
  const runtime = {
    streamSimple: (_model, context) => {
      forwarded = context;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
      return stream;
    },
  };
  installMemoryRequestGuard(
    runtime,
    async () => approvedContext,
    () => {
      delivered++;
    },
  );
  const reply = await runtime.streamSimple(model, originalContext).result();
  assert.equal(forwarded, approvedContext);
  assert.equal(reply, output);
  assert.equal(delivered, 1);
});

test("cancel/compile failure closes the result without calling the provider, even if the UI has disappeared", async () => {
  let dispatched = 0,
    delivered = 0;
  const runtime = {
    streamSimple: () => {
      dispatched++;
      throw Error("must not dispatch");
    },
  };
  installMemoryRequestGuard(
    runtime,
    async () => {
      throw Error("cancelled approval");
    },
    () => {
      delivered++;
    },
    () => {
      throw Error("disconnected UI");
    },
  );
  const reply = await runtime.streamSimple(model, originalContext).result();
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage, /cancelled/);
  assert.equal(reply.usage.totalTokens, 0);
  assert.equal(dispatched, 0);
  assert.equal(delivered, 0);
});

test("abort racing with approval does not dispatch and reports an aborted stream", async () => {
  let dispatched = 0;
  const controller = new globalThis.AbortController();
  const runtime = {
    streamSimple: () => {
      dispatched++;
    },
  };
  installMemoryRequestGuard(runtime, async () => {
    controller.abort();
    return approvedContext;
  });
  const reply = await runtime.streamSimple(model, originalContext, { signal: controller.signal }).result();
  assert.equal(reply.stopReason, "aborted");
  assert.equal(dispatched, 0);
});

test("a delivered observer error cannot replace a completed provider response", async () => {
  const runtime = {
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
      return stream;
    },
  };
  installMemoryRequestGuard(
    runtime,
    async () => approvedContext,
    () => {
      throw Error("observer gone");
    },
  );
  const stream = runtime.streamSimple(model, originalContext);
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["done"]);
  assert.equal(await stream.result(), output);
});
