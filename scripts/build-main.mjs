#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSuccessfulSpawn, resolvePackageFile } from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function cleanMainBuildOutputs(projectRoot = root) {
  fs.rmSync(path.join(projectRoot, "out", "main"), { recursive: true, force: true });
  fs.rmSync(path.join(projectRoot, "out", "preload"), { recursive: true, force: true });
}

export function buildMain(projectRoot = root) {
  cleanMainBuildOutputs(projectRoot);
  const tsupCli = resolvePackageFile(projectRoot, "tsup", "dist/cli-default.js");
  assertSuccessfulSpawn(
    spawnSync(process.execPath, [tsupCli, "--config", "tsup.config.ts"], {
      cwd: projectRoot,
      stdio: "inherit",
    }),
    "main/preload/host build",
  );
  // These adapters are source assets owned by Desktop. Their OpenCLI imports
  // are bound to the external app's public exports when a Web turn starts.
  const adapters = path.join(projectRoot, "out", "main", "web-adapters");
  for (const site of ["chatgpt", "deepseek"]) {
    fs.mkdirSync(path.join(adapters, site), { recursive: true });
    for (const file of ["ask.js", "utils.js"]) {
      fs.copyFileSync(
        path.join(projectRoot, "extras", "opencli-web-repair", "clis", site, file),
        path.join(adapters, site, file),
      );
    }
  }
  fs.copyFileSync(path.join(projectRoot, "extras", "opencli-web-repair", "LICENSE"), path.join(adapters, "LICENSE"));
  fs.writeFileSync(path.join(adapters, "package.json"), '{"type":"module"}\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    buildMain();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
