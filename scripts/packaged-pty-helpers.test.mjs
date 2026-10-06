import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repairPackagedPtyHelpers, verifyPackagedPtyHelpers } from "./packaged-pty-helpers.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pty-permissions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "app.asar.unpacked/node_modules/node-pty");
  const files = ["build/Release", "prebuilds/darwin-arm64"].map((dir) => {
    const directory = path.join(runtime, dir);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "pty.node"), "native fixture");
    const file = path.join(directory, "spawn-helper");
    fs.writeFileSync(file, "helper fixture", { mode: 0o644 });
    return file;
  });
  return { root, files };
}

test("packaging repairs both selectable macOS helpers without changing their contents", (t) => {
  const { root, files } = fixture(t);
  assert.throws(() => verifyPackagedPtyHelpers(root, "darwin", "arm64"), /not executable/);
  assert.equal(repairPackagedPtyHelpers(root, "darwin", "arm64"), 2);
  assert.equal(verifyPackagedPtyHelpers(root, "darwin", "arm64"), 2);
  for (const file of files) assert.equal(fs.readFileSync(file, "utf8"), "helper fixture");
});

test("missing or redirected helper fails packaging", (t) => {
  const { root, files } = fixture(t);
  fs.unlinkSync(files[0]);
  assert.throws(() => repairPackagedPtyHelpers(root, "darwin", "arm64"), /ENOENT/);
  fs.symlinkSync(files[1], files[0]);
  assert.throws(() => repairPackagedPtyHelpers(root, "darwin", "arm64"), /regular file/);
});

test("non-macOS packaging needs no macOS spawn helper", () => {
  assert.equal(repairPackagedPtyHelpers("/unused", "win32", "x64"), 0);
});
