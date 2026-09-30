import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { HostManager } from "../main/host-manager";
import { ToolchainManager } from "../main/toolchains/manager";
import { resolveRuntimeCatalogPath } from "../main/toolchains/catalog";
import { isExecutionIntent } from "../shared/toolchains/types";
import { searchMemoryMarkdown, openMemoryMarkdown } from "../agent-host/memory/markdown-store.mjs";

const root = process.env.PI_MEMORY_E2E_ROOT;
const hostEntry = process.env.PI_MEMORY_E2E_HOST_ENTRY;
assert.ok(root && path.isAbsolute(root) && hostEntry && path.isAbsolute(hostEntry));
const project = path.join(root, "fictional-project");
const agent = path.join(root, "agent");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(agent, { recursive: true });
app.setPath("userData", path.join(root, "user-data"));
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agent, "sessions");
process.env.PI_OFFLINE = "1";
fs.writeFileSync(
  path.join(agent, "models.json"),
  JSON.stringify({
    providers: {
      "ollama-local": {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        models: [
          {
            id: "pi-qwen3-4b-summary:q4km",
            name: "Local Qwen memory",
            reasoning: false,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 768,
          },
        ],
      },
    },
  }),
  { mode: 0o600 },
);
const pageExtension = process.env.PI_MEMORY_E2E_PAGE_EXTENSION;
const pageRequestFile = path.join(root, "fake-page-request.json");
if (pageExtension) {
  assert.ok(path.isAbsolute(pageExtension) && fs.existsSync(pageExtension));
  const node = process.env.PI_MEMORY_E2E_NODE;
  assert.ok(node && path.isAbsolute(node));
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ extensions: [pageExtension] }));
  const fakeBridge = path.join(root, "fake-page-bridge.mjs");
  fs.writeFileSync(
    fakeBridge,
    `#!${node}\nimport fs from 'node:fs';\nlet data=''; for await (const chunk of process.stdin) data+=chunk; const request=JSON.parse(data); fs.writeFileSync(${JSON.stringify(pageRequestFile)}, JSON.stringify(request.params)); console.log(JSON.stringify({type:'turn.completed',turnId:request.id,message:{markdown:'Fictional Page Provider completed reply'},remote:{site:'chatgpt',mode:'chat',conversationId:'fictional',conversationUrl:'https://chatgpt.com/c/fictional'}}));\n`,
    { mode: 0o700 },
  );
  process.env.PI_PAGE_PROVIDER_BRIDGE = fakeBridge;
}
let host: HostManager | undefined;
let window: BrowserWindow | undefined;
async function waitFor<T>(
  label: string,
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  ms = 135_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      last = value;
    } catch (error) {
      last = error;
    }
    if (!(last instanceof Error) && ok(last as T)) return last as T;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
type Status = {
  isRunning: boolean;
  isStreaming: boolean;
  assistantTexts: string[];
  assistantErrors: string[];
  memoryEntries: Array<{ path: string; hash: string; id: string; summary: string; modelId: string }>;
  sessionFile?: string;
  notifications: string[];
};
async function run() {
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL("data:text/html,<title>Isolated fictional memory E2E</title>");
  const tools = new ToolchainManager({
    homeDir: app.getPath("home"),
    tempRoot: root!,
    userDataRoot: app.getPath("userData"),
    resourcesRoot: process.resourcesPath,
    catalogPath: resolveRuntimeCatalogPath({ isPackaged: false, resourcesRoot: process.resourcesPath }),
  });
  await tools.initialize();
  host = new HostManager(hostEntry!);
  host.setToolchainSnapshot(tools.getSnapshot());
  host.setRequestHandler(async (method, params) => {
    if (method === "toolchain.getSnapshot") return tools.getSnapshot();
    if (method === "toolchain.resolve") {
      const { cwd, intent, trusted } = params as { cwd: string; intent: unknown; trusted: boolean };
      if (cwd !== project || !isExecutionIntent(intent) || typeof trusted !== "boolean")
        throw Error("Invalid toolchain request");
      return tools.resolveForProject(cwd, { intent, trusted });
    }
    if (method === "managedProcesses.getSettings") return { enabled: false, reaperReady: false };
    throw Error(`Disallowed test Host request: ${method}`);
  });
  host.start();
  await waitFor(
    "Agent Host ready",
    () => host!.getStatus(),
    (v) => v === "ready",
    25_000,
  );
  const created = await host.call<{ sessionId: string }>(
    "agent.new",
    { cwd: project, type: "ensure_session", toolNames: [] },
    35_000,
  );
  const sessionId = created.sessionId;
  assert.ok(sessionId);
  const commands = await host.call<{ commands: Array<{ name: string }> }>(
    "agent.command",
    { sessionId, command: { type: "get_commands" } },
    15_000,
  );
  assert.ok(
    commands.commands.some((c) => c.name === "task-memory-preview"),
    "preview command missing",
  );
  await host.call("memoryE2e.configure", { sessionId });
  await host.call(
    "agent.command",
    {
      sessionId,
      command: {
        type: "prompt",
        message: "虚构任务：设计一个完全离线的记忆库；确认决定为 Markdown 保留来源，不得外发。",
      },
    },
    15_000,
  );
  const complete = await waitFor<Status>(
    "Ollama → Markdown → Pi entry",
    () => host!.call("memoryE2e.status", { sessionId }),
    (v) => v.memoryEntries.length > 0 && !v.isRunning && !v.isStreaming,
  );
  assert.ok(complete.assistantTexts.some((text) => text.includes("虚构决策")));
  const entry = complete.memoryEntries.at(-1)!;
  assert.equal(entry.modelId, "ollama-local/pi-qwen3-4b-summary:q4km");
  assert.ok(entry.summary && entry.hash && entry.id);
  assert.ok(complete.sessionFile?.startsWith(root!));
  const vault = path.join(agent, "task-memory-vault");
  const markdown = fs.readFileSync(path.join(vault, entry.path), "utf8");
  assert.ok(markdown.includes(sessionId) && markdown.includes("## Sources"));
  const hits = searchMemoryMarkdown(vault, sessionId);
  const hit = hits.find((item) => item.path === entry.path);
  assert.ok(hit);
  assert.equal(openMemoryMarkdown(vault, hit), markdown);
  const preview = await host.call<{ title: string; message: string }>("memoryE2e.preview", { sessionId }, 15_000);
  assert.ok(preview.title.includes("ollama-local") && preview.message.includes(entry.summary));
  console.log("Preview UI event verified against local summary");

  if (pageExtension) {
    await host.call("agent.command", {
      sessionId,
      command: { type: "set_model", provider: "opencli-page", modelId: "chatgpt-web" },
    });
    await host.call("agent.command", {
      sessionId,
      command: { type: "prompt", message: "虚构切换：继续本机记忆库设计；回包来自假桥，不访问网站。" },
    });
    const pageStatus = await waitFor<Status>(
      "approved local memory → Page Provider → fake bridge",
      () => host!.call("memoryE2e.status", { sessionId }),
      (v) =>
        (v.assistantTexts.includes("Fictional Page Provider completed reply") || v.assistantErrors.length > 0) &&
        !v.isRunning &&
        !v.isStreaming,
    );
    assert.deepEqual(pageStatus.assistantErrors, [], "Page delivery failed");
    const sent = JSON.parse(fs.readFileSync(pageRequestFile, "utf8")) as { text: string };
    assert.ok(sent.text.startsWith("[PI APPROVED MEMORY HANDOFF v1]"));
    assert.equal((sent.text.match(/\[PI APPROVED MEMORY HANDOFF v1\]/g) ?? []).length, 1);
    assert.ok(!sent.text.includes("### Checkpoint") && sent.text.length <= 24_000);
    console.log("Desktop approval receipt → real Page Provider registration → exact fake-bridge prompt verified");
    await host.call("memoryE2e.configure", { sessionId });
  }

  const beforeWarm = await host.call<Status>("memoryE2e.status", { sessionId });
  // A long *fictional* current turn forces older projected entries into warm.
  // Nothing here is read from the user's actual Pi sessions.
  await host.call(
    "agent.command",
    {
      sessionId,
      command: { type: "prompt", message: `虚构第二阶段：${"Fictional offline memory boundary.\n\n".repeat(420)}` },
    },
    15_000,
  );
  const warmed = await waitFor<Status>(
    "warm promotion",
    () => host!.call("memoryE2e.status", { sessionId }),
    (v) => {
      if (
        !v.isRunning &&
        !v.isStreaming &&
        (v.assistantTexts.length > beforeWarm.assistantTexts.length ||
          v.assistantErrors.length > beforeWarm.assistantErrors.length) &&
        !v.memoryEntries.some((e) => e.path.startsWith("warm/"))
      )
        throw new Error(`Warm promotion ended without a warm stage: ${JSON.stringify(v)}`);
      return v.memoryEntries.some((e) => e.path.startsWith("warm/")) && !v.isRunning && !v.isStreaming;
    },
  );
  const warm = warmed.memoryEntries.findLast((e) => e.path.startsWith("warm/"))!;
  const warmFile = path.join(vault, warm.path);
  const originalWarm = fs.readFileSync(warmFile, "utf8");
  assert.ok(originalWarm.includes(sessionId) && originalWarm.includes("## Sources"));
  await host.stop();
  host.start();
  await waitFor(
    "restarted Host ready",
    () => host!.getStatus(),
    (value) => value === "ready",
    25_000,
  );
  await host.call("agent.command", { sessionId, command: { type: "get_state" } });
  await host.call("memoryE2e.configure", { sessionId });
  await host.call("agent.command", { sessionId, command: { type: "prompt", message: "/task-memory-refresh" } });
  const resumed = await host.call<Status>("memoryE2e.status", { sessionId });
  assert.equal(
    resumed.memoryEntries.length,
    warmed.memoryEntries.length,
    "restart duplicated an unchanged memory stage",
  );
  assert.equal(fs.readFileSync(warmFile, "utf8"), originalWarm, "restart rewrote an unchanged memory stage");
  console.log("Persisted cursor restored after Host restart without rewriting the warm stage");
  const edited = `${originalWarm}\n人工测试编辑：必须保留。\n`;
  fs.writeFileSync(warmFile, edited);
  await host.call(
    "agent.command",
    { sessionId, command: { type: "prompt", message: "虚构第三阶段：核查先前的人工作业，不应覆盖温层文件。" } },
    15_000,
  );
  const protectedStatus = await waitFor<Status>(
    "manual edit protection",
    () => host!.call("memoryE2e.status", { sessionId }),
    (v) =>
      v.notifications.some((text) => text.includes("manual edits were preserved")) && !v.isRunning && !v.isStreaming,
  );
  assert.equal(protectedStatus.memoryEntries.length, warmed.memoryEntries.length, "failed write was marked successful");
  assert.equal(fs.readFileSync(warmFile, "utf8"), edited, "manual edit was overwritten");
  console.log(
    `PASS fictional Pi → local Ollama → hot + warm Markdown, actual preview, search/open, manual edit preserved; session=${sessionId}`,
  );
}
void app.whenReady().then(
  () =>
    run().then(
      async () => {
        await host?.stop();
        window?.destroy();
        app.exit(0);
      },
      async (error) => {
        console.error(error);
        await host?.stop().catch(() => {});
        window?.destroy();
        app.exit(1);
      },
    ),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
