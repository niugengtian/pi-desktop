#!/usr/bin/env node
// Exercise the shipped Host module graph and initialization using Electron's Node
// runtime. The parent-port shim is a test driver, not a utilityProcess/GUI test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertSuccessfulSpawn } from "./process-utils.mjs";

const app = process.argv[2];
if (process.platform !== "darwin" || !app || process.argv.length !== 3)
  throw new Error("Usage: node scripts/test-packaged-host-startup.mjs /path/to/Pi-Agent-Desktop.app");
const root = path.resolve(app);
const executable = path.join(root, "Contents", "MacOS", "Pi Agent Desktop");
const host = path.join(root, "Contents", "Resources", "app.asar", "out", "main", "agent-host.mjs");
const expected = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies[
  "@earendil-works/pi-coding-agent"
];
const directory = mkdtempSync(path.join(tmpdir(), "pi-packaged-host-fictional-"));
try {
  const external = path.join(directory, "fictional-opencli");
  mkdirSync(path.join(external, "dist/src"), { recursive: true });
  mkdirSync(path.join(external, "clis/deepseek"), { recursive: true });
  writeFileSync(path.join(external, "package.json"), '{"name":"@jackwener/opencli","type":"module"}');
  writeFileSync(
    path.join(external, "dist/src/execution.js"),
    'export async function executeCommand(){return [{Login:"yes",Status:"connected",Url:"https://chat.deepseek.com/"}]}',
  );
  writeFileSync(
    path.join(external, "clis/deepseek/status.js"),
    'export const statusCommand={site:"deepseek",name:"status"};',
  );
  const driver = path.join(directory, "driver.mjs");
  writeFileSync(
    driver,
    `import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
delete process.env.PI_PAGE_PROVIDER_BRIDGE;
process.env.OPENCLI_PACKAGE_ROOT = ${JSON.stringify(external)};
process.env.PI_PAGE_PROVIDER_NODE = "/fictional/unavailable-system-node";
const builtin = await import(pathToFileURL(${JSON.stringify(path.join(path.dirname(host), "builtin-page-provider.mjs"))}).href);
const commands = new Map();
builtin.default({on(){},registerProvider(){},registerCommand(name,command){commands.set(name,command)}});
const notifications = [];
await commands.get("page-provider-status").handler("", {model:{id:"deepseek-chat"},ui:{setStatus(){},notify(text,type){notifications.push({text,type})}}});
if (!notifications.some(n => n.type === "info" && n.text.includes("ready")))
  throw new Error("ASAR-aware built-in bridge launch failed: " + JSON.stringify(notifications));
console.log("PACKAGED_BUILTIN_BRIDGE_READY fictional external runtime");
const port = new EventEmitter();
process.parentPort = port;
let ready = false;
const renderer = new EventEmitter();
renderer.start = () => {};
renderer.postMessage = message => {
  if (message.kind !== "response" || message.id !== "first-install-models") return;
  if (!message.ok) throw new Error("Packaged model list failed: " + JSON.stringify(message.error));
  const ids = message.result.models.filter(model => model.provider === "opencli-page").map(model => model.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(["chatgpt-web", "deepseek-chat", "deepseek-reasoner"]))
    throw new Error("Built-in Web models missing on first install: " + JSON.stringify(ids));
  console.log("PACKAGED_FIRST_INSTALL_WEB_MODELS " + ids.join(","));
  setImmediate(() => port.emit("message", {data: {type: "shutdown"}}));
};
port.postMessage = message => {
  if (message.type !== "ready") return;
  if (message.piVersion !== ${JSON.stringify(expected)}) throw new Error("Packaged SDK version mismatch");
  ready = true;
  console.log("PACKAGED_HOST_READY " + message.piVersion);
  setImmediate(() => {
    port.emit("message", {data: {type: "attach-port"}, ports:[renderer]});
    renderer.emit("message", {data: {kind:"request", id:"first-install-models", method:"models.list", params:{cwd:${JSON.stringify(directory)}}}});
  });
};
await import(pathToFileURL(${JSON.stringify(host)}).href);
if (!ready) throw new Error("Packaged Host did not finish initialization");
`,
  );
  const result = spawnSync(executable, [driver], {
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_CODING_AGENT_DIR: path.join(directory, "agent"),
      PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"),
      PI_DESKTOP_USER_DATA: path.join(directory, "desktop"),
      PI_OFFLINE: "1",
      NODE_OPTIONS: "",
      NODE_PATH: "",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assertSuccessfulSpawn(result, "Packaged Host initialization/shutdown");
  if (!result.stdout.includes(`PACKAGED_HOST_READY ${expected}`)) throw new Error("Missing Host readiness receipt");
  if (!result.stdout.includes("PACKAGED_FIRST_INSTALL_WEB_MODELS"))
    throw new Error("Missing first-install Web model receipt");
  if (!result.stdout.includes("PACKAGED_BUILTIN_BRIDGE_READY"))
    throw new Error("Missing built-in bridge launch receipt");
  console.log("PASS: packaged Host initialized and shut down with isolated stores (Node-mode driver, not GUI).");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
