import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("fresh API selection and same-model tool continuation preserve native context even without reported usage/UI", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-controller-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const { createMemoryDeliveryController } = await importTestBundle("memory-delivery-controller", {
    entryPoints: [path.join(import.meta.dirname, "controller.ts")],
    packages: "external",
    absWorkingDir: path.resolve(import.meta.dirname, "../../.."),
  });
  const controller = createMemoryDeliveryController(path.join(dir, "vault"));
  const handlers = new Map();
  controller.extension.factory({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {} });
  const model = { provider: "fixture-api", api: "openai-completions", id: "a", contextWindow: 128000 };
  const user = { role: "user", content: "Fictional current request", timestamp: 1 };
  const entry = { type: "message", id: "pending", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: user };
  const ctx = {
    hasUI: false,
    model,
    getContextUsage: () => ({ tokens: null }),
    sessionManager: {
      getBranch: () => [entry],
      getLeafId: () => "pending",
      getSessionId: () => "fictional-controller",
    },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("model_select")({ previousModel: { ...model, id: "unused-default" } }, ctx);
  const initial = normalizeContext({ systemPrompt: "Current API system", messages: [user] });
  assert.equal(await controller.prepare(model, initial), initial);
  controller.delivered(model);
  const continuation = normalizeContext({
    systemPrompt: "Current API system",
    messages: [
      user,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool", name: "fictional_tool", arguments: {} }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "tool",
        toolName: "fictional_tool",
        content: [{ type: "text", text: "local result" }],
        isError: false,
        timestamp: 2,
      },
    ],
  });
  assert.equal(await controller.prepare(model, continuation), continuation);
  await assert.rejects(controller.prepare({ ...model, id: "b" }, continuation), /approval UI/);
});
