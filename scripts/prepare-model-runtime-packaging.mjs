import fs from "node:fs";
import path from "node:path";
import { verifyModelDependencies } from "./verify-packaged-model-dependencies.mjs";

export function modelRuntimeFileSets(projectDir) {
  const packages = new Map();
  verifyModelDependencies((directory) => {
    const filename = path.join(projectDir, directory, "package.json");
    if (!fs.existsSync(filename)) return undefined;
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    packages.set(directory, manifest);
    return manifest;
  });
  return [...packages.keys()].map((directory) => ({
    from: directory,
    to: directory,
    // Nested packages get their own FileSet, preserving Node resolution without
    // copying the same ASAR member twice. Keep all other runtime/authoring assets.
    filter: ["**/*", "!node_modules/**/*"],
  }));
}

export default async function prepareModelRuntime(context) {
  const config = context.packager.config;
  const sets = modelRuntimeFileSets(context.packager.projectDir);
  // Remove declaration-only restores covered by complete package FileSets.
  const files = (config.files ?? []).filter((entry) => {
    if (typeof entry === "string") return true;
    return !sets.some((set) => entry.from === set.from || entry.from?.startsWith(`${set.from}/`));
  });
  config.files = [...files, ...sets.map((set) => `!${set.to}/**/*`), ...sets];
  console.log(`[package] explicitly preserving ${sets.length} model runtime packages`);
}
