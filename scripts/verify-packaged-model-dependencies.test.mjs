import assert from "node:assert/strict";
import test from "node:test";
import { verifyModelDependencies } from "./verify-packaged-model-dependencies.mjs";

const ai = "node_modules/@earendil-works/pi-ai";
function fixture() {
  return {
    [ai]: { version: "0.87.1", dependencies: { openai: "6.40.0" } },
    "node_modules/openai": { version: "6.40.0", dependencies: { transport: "^1.0.0" } },
    "node_modules/transport": { version: "1.0.0" },
  };
}

test("resolves hoisted SDKs and their complete runtime closure", () => {
  const packages = fixture();
  assert.equal(
    verifyModelDependencies((dir) => packages[dir]),
    3,
  );
});

test("missing OpenAI SDK fails even when pi-ai JavaScript is packaged", () => {
  const packages = fixture();
  delete packages["node_modules/openai"];
  assert.throws(() => verifyModelDependencies((dir) => packages[dir]), /missing: openai/);
});

test("missing transitive dependencies and incompatible versions fail", () => {
  const packages = fixture();
  delete packages["node_modules/transport"];
  assert.throws(() => verifyModelDependencies((dir) => packages[dir]), /missing: transport/);
  packages["node_modules/transport"] = { version: "2.0.0" };
  assert.throws(() => verifyModelDependencies((dir) => packages[dir]), /version mismatch/);
});

test("checks coding-agent's restored nested pi-ai, not just the root copy", () => {
  const packages = fixture();
  packages["node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai"] = {
    version: "0.87.1",
    dependencies: { "@anthropic-ai/sdk": "0.124.0" },
  };
  assert.throws(() => verifyModelDependencies((dir) => packages[dir]), /missing: @anthropic-ai\/sdk/);
});

test("nested SDKs follow Node resolution and cyclic dependencies terminate", () => {
  const packages = fixture();
  packages[`${ai}/node_modules/openai`] = { version: "6.40.0", dependencies: { "@earendil-works/pi-ai": "0.87.1" } };
  delete packages["node_modules/openai"];
  assert.equal(
    verifyModelDependencies((dir) => packages[dir]),
    2,
  );
});
