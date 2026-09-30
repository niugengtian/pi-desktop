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
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "sessions");
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
      if (ok(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
type Status = {
  isRunning: boolean;
  isStreaming: boolean;
  assistantTexts: string[];
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

  // A long *fictional* current turn forces older projected entries into warm.
  // Nothing here is read from the user's actual Pi sessions.
  await host.call(
    "agent.command",
    {
      sessionId,
      command: { type: "prompt", message: `虚构第二阶段：${"讨论离线任务记忆的边界与来源。".repeat(850)}` },
    },
    15_000,
  );
  const warmed = await waitFor<Status>(
    "warm promotion",
    () => host!.call("memoryE2e.status", { sessionId }),
    (v) => v.memoryEntries.some((e) => e.path.startsWith("warm/")) && !v.isRunning && !v.isStreaming,
  );
  const warm = warmed.memoryEntries.findLast((e) => e.path.startsWith("warm/"))!;
  const warmFile = path.join(vault, warm.path);
  const originalWarm = fs.readFileSync(warmFile, "utf8");
  assert.ok(originalWarm.includes(sessionId) && originalWarm.includes("## Sources"));
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
