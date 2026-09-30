import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import prepare, { modelRuntimeFileSets } from "./prepare-model-runtime-packaging.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-packaging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [dir, manifest] of Object.entries({
    "node_modules/@earendil-works/pi-ai": { version: "0.87.1", dependencies: { openai: "6.40.0" } },
    "node_modules/openai": { version: "6.40.0", dependencies: { transport: "1.0.0" } },
    "node_modules/openai/node_modules/transport": { version: "1.0.0" },
  })) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

test("complete FileSets preserve nested dependency locations exactly once", (t) => {
  const sets = modelRuntimeFileSets(fixture(t));
  assert.equal(sets.length, 3);
  assert.ok(sets.some((set) => set.to === "node_modules/openai/node_modules/transport"));
  for (const set of sets) {
    assert.equal(set.from, set.to);
    assert.deepEqual(set.filter, ["**/*", "!node_modules/**/*"]);
  }
});

test("beforePack excludes default copies and removes overlapping declaration restores", async (t) => {
  const config = { files: ["out/**/*", { from: "node_modules/@earendil-works/pi-ai/dist", filter: ["**/*.d.ts"] }] };
  await prepare({ packager: { projectDir: fixture(t), config } });
  assert.ok(config.files.includes("out/**/*"));
  assert.ok(config.files.includes("!node_modules/openai/**/*"));
  assert.equal(config.files.filter((entry) => typeof entry === "object").length, 3);
  assert.ok(!config.files.some((entry) => entry.from === "node_modules/@earendil-works/pi-ai/dist"));
});
