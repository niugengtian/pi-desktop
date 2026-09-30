#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import {
  createProjectBuildTemp,
  projectNodePath,
  resolveElectronBinary,
  terminateProcessTree,
} from "./process-utils.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = createProjectBuildTemp(project, "pi-memory-e2e-");
const host = path.join(temp, "host.mjs");
const main = path.join(temp, "harness.cjs");
const root = path.join(temp, "runtime");
fs.mkdirSync(root, { recursive: true });
function build(entry, outfile, format, external) {
  buildSync({
    absWorkingDir: project,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    packages: "external",
    format,
    external,
    outfile,
    logLevel: "warning",
  });
}
try {
  build("src/smoke/browser-agent-host.ts", host, "esm", [
    "electron",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "silk-wasm",
  ]);
  build("src/smoke/memory-e2e-harness.ts", main, "cjs", ["electron"]);
  const child = spawn(resolveElectronBinary(project), [main], {
    cwd: project,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_PATH: projectNodePath(project, process.env.NODE_PATH),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PI_MEMORY_E2E_ROOT: root,
      PI_MEMORY_E2E_HOST_ENTRY: host,
    },
  });
  process.exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error("Memory E2E timed out");
      terminateProcessTree(child);
      resolve(1);
    }, 170_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve(1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
