import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settled } from "node:timers/promises";
import { Type } from "typebox";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTieredWorkspaceExtension } from "./tiered-extension.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost };

test("real SDK + loopback HTTP: baseline/off/on dispatch the same native warm+hot across A-B-A", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tiered-sdk-fictional-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const captures = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    captures.push({ path: req.url, body }); // Body only; never persist auth headers.
    assert.ok(["/a/chat/completions", "/b/chat/completions"].includes(req.url));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "fictional-response", object: "chat.completion.chunk", created: 1, model: body.model };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "FICTIONAL_REPLY" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rounds = [];
  for (const mode of ["baseline", "off", "on"]) {
    // Identical bound cwd across modes: compare full wire bodies without masking differences.
    const cwd = join(root, "project");
    const agentDir = join(root, `agent-${mode}`);
    if (!existsSync(cwd)) mkdirSync(cwd);
    mkdirSync(agentDir);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "fictional-auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    for (const id of ["a", "b"])
      runtime.registerProvider(`fictional-${id}`, {
        api: "openai-completions",
        baseUrl: `${origin}/${id}`,
        apiKey: "fictional-local-only",
        models: [
          {
            id,
            name: `Fictional ${id}`,
            reasoning: false,
            input: ["text"],
            cost: zeroCost,
            contextWindow: 65536,
            maxTokens: 256,
          },
        ],
      });
    const manager = SessionManager.create(cwd, join(root, `native-${mode}`));
    manager.appendModelChange("fictional-a", "a");
    manager.appendMessage({ role: "system", content: "FICTIONAL_SYSTEM", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "COLD_ONLY_OLD_TEXT", timestamp: 2 });
    const assistant = (content, stopReason = "stop") =>
      manager.appendMessage({
        role: "assistant",
        content,
        stopReason,
        provider: "fictional-a",
        model: "a",
        api: "openai-completions",
        usage,
        timestamp: 3,
      });
    assistant([{ type: "text", text: "OLD_ACK" }]);
    const kept = manager.appendMessage({ role: "user", content: "HOT_UNCOVERED_17", timestamp: 4 });
    assistant(
      [{ type: "toolCall", id: "fixture-call", name: "fictional_read", arguments: { file: "fiction.txt" } }],
      "toolUse",
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "fixture-call",
      toolName: "fictional_read",
      content: [{ type: "text", text: "HOT_TOOL_RESULT" }],
      isError: false,
      timestamp: 5,
    });
    assistant([{ type: "text", text: "HOT_ACK" }]);
    manager.appendCompaction("NATIVE_WARM_PLAN_NOT_COMPLETED", kept, 100);
    const historyPrefix = readFileSync(manager.getSessionFile());
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: "off",
        defaultThinkingLevel: "off",
        enableAnalytics: false,
        enableInstallTelemetry: false,
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => "FICTIONAL_SYSTEM",
        extensionFactories: mode === "baseline" ? [] : [createTieredWorkspaceExtension()],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: runtime.getModel("fictional-a", "a"),
      thinkingLevel: "off",
      tools: ["fictional_read"],
      customTools: [
        {
          name: "fictional_read",
          label: "Fixture read",
          description: "Fictional only",
          parameters: Type.Object({ file: Type.String() }),
          execute: async () => ({ content: [{ type: "text", text: "UNEXPECTED_EXECUTION" }], details: {} }),
        },
      ],
    });
    const notices = [];
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        confirm: async () => true,
        notify: (text) => notices.push(text),
        setStatus: () => {},
        setWidget: () => {},
        setTitle: () => {},
      },
    });
    try {
      const workspaceRoot = join(cwd, `pi_agent_desktop_session-${manager.getSessionId()}`);
      if (mode === "on") {
        await session.prompt("/tiered-workspace-enable");
        assert.equal(existsSync(workspaceRoot), true, notices.join("\n"));
      }
      const start = captures.length;
      for (const [id, prompt] of [
        ["a", "CURRENT_A_1"],
        ["b", "CURRENT_B_2"],
        ["a", "CURRENT_A_3"],
      ]) {
        await session.setModel(runtime.getModel(`fictional-${id}`, id));
        await session.prompt(prompt);
        await settled();
      }
      rounds.push(captures.slice(start));
      assert.equal(captures.length - start, 3, "No probe, handoff prompt, summary call, retry or fallback");
      const finalHistory = readFileSync(manager.getSessionFile());
      assert.deepEqual(finalHistory.subarray(0, historyPrefix.length), historyPrefix);
      if (mode !== "on") assert.equal(existsSync(workspaceRoot), false);
      if (mode === "on") {
        const warm = JSON.parse(readFileSync(join(workspaceRoot, "warm/manifest.json")));
        assert.equal(warm.summary, "NATIVE_WARM_PLAN_NOT_COMPLETED");
        const hot = readFileSync(join(workspaceRoot, "hot/messages.jsonl"), "utf8");
        assert.match(hot, /CURRENT_A_3/);
        assert.doesNotMatch(hot, /COLD_ONLY_OLD_TEXT/);
      }
    } finally {
      session.dispose();
    }
  }
  for (const mode of [1, 2])
    assert.deepEqual(rounds[mode], rounds[0], "Feature is a local mirror, not an extra context strategy");
  for (const { body } of rounds[2]) {
    const text = JSON.stringify(body.messages);
    assert.equal(text.split("NATIVE_WARM_PLAN_NOT_COMPLETED").length - 1, 1);
    assert.equal(text.includes("COLD_ONLY_OLD_TEXT"), false);
    assert.equal(text.includes("HOT_UNCOVERED_17"), true);
    assert.equal(text.includes("HOT_TOOL_RESULT"), true);
    assert.ok(body.tools.some((tool) => tool.function.name === "fictional_read"));
    assert.ok(body.messages.some((message) => message.role === "tool" && message.tool_call_id === "fixture-call"));
  }
});
