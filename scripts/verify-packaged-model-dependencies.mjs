import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import semver from "semver";

// Resolve inside the archive, not against the development machine's node_modules.
export function verifyModelDependencies(readManifest) {
  const visited = new Set();
  function resolve(owner, name) {
    for (let dir = owner; ; dir = path.posix.dirname(dir)) {
      if (path.posix.basename(dir) !== "node_modules") {
        const candidate = path.posix.join(dir === "." ? "" : dir, "node_modules", name);
        const manifest = readManifest(candidate);
        if (manifest) return { directory: candidate, manifest };
      }
      if (dir === ".") break;
    }
    throw new Error(`Packaged model dependency missing: ${name} (required by ${owner || "app"})`);
  }
  function visit(directory, manifest) {
    if (visited.has(directory)) return;
    visited.add(directory);
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const child = resolve(directory, name);
      if (semver.validRange(range) && !semver.satisfies(child.manifest.version, range)) {
        throw new Error(
          `Packaged model dependency version mismatch: ${name}@${child.manifest.version}, expected ${range}`,
        );
      }
      visit(child.directory, child.manifest);
    }
  }
  for (const owner of ["", "node_modules/@earendil-works/pi-coding-agent"]) {
    const ai = resolve(owner, "@earendil-works/pi-ai");
    visit(ai.directory, ai.manifest);
  }
  return visited.size;
}

export function verifyModelArchive(archive) {
  const files = new Set(listPackage(archive).map((entry) => entry.replace(/^\//, "")));
  return verifyModelDependencies((directory) => {
    const filename = `${directory}/package.json`;
    return files.has(filename) ? JSON.parse(extractFile(archive, filename).toString()) : undefined;
  });
}

// electron-builder afterPack runs for directory, signed, and release builds.
export default async function verifyPackagedModels(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const archive = path.join(resources, "app.asar");
  const count = verifyModelArchive(archive);
  console.log(`[package] verified ${count} model runtime packages in ${archive}`);
}
