import fs from "node:fs";
import path from "node:path";

function helpers(resources, platform, arch) {
  if (platform !== "darwin") return [];
  const root = path.join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  const found = [];
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${arch}`]) {
    const native = path.join(root, directory, "pty.node");
    if (!fs.existsSync(native)) continue;
    const helper = path.join(root, directory, "spawn-helper");
    const stat = fs.lstatSync(helper);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`PTY helper must be a regular file: ${helper}`);
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(helper));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PTY helper escapes packaged runtime");
    found.push(helper);
  }
  if (!found.length) throw new Error("Packaged macOS PTY runtime has no unpacked spawn helper");
  return found;
}

/** Run after ASAR creation and before signing. chmod changes no binary content. */
export function repairPackagedPtyHelpers(resources, platform, arch) {
  const files = helpers(resources, platform, arch);
  for (const file of files) fs.chmodSync(file, fs.statSync(file).mode | 0o111);
  return files.length;
}

export function verifyPackagedPtyHelpers(resources, platform, arch) {
  const files = helpers(resources, platform, arch);
  for (const file of files) {
    if ((fs.statSync(file).mode & 0o111) !== 0o111) throw new Error(`Packaged PTY helper is not executable: ${file}`);
  }
  return files.length;
}
