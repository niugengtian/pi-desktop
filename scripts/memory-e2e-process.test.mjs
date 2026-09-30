import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MEMORY_E2E_TOTAL_BUDGET_MS, waitForMemoryFixture } from "./memory-e2e-process.mjs";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const child = new EventEmitter();
  const terminations = [];
  const pending = waitForMemoryFixture(child, {
    timeoutMs: 100,
    terminate: (_child, options) => terminations.push(options?.signal ?? "SIGTERM"),
  });
  return { child, pending, terminations };
}

test("aggregate budget covers all bounded inference stages", () => {
  assert.ok(MEMORY_E2E_TOTAL_BUDGET_MS >= 4 * 135_000 + 25_000 + 35_000);
});

test("normal close preserves status and clears termination timers", async (t) => {
  const { child, pending, terminations } = fixture(t);
  child.emit("close", 0);
  assert.equal(await pending, 0);
  t.mock.timers.tick(10_000);
  assert.deepEqual(terminations, []);
});

test("timeout waits for close before permitting profile cleanup", async (t) => {
  const { child, pending, terminations } = fixture(t);
  let cleaned = false;
  const cleanup = pending.then(() => {
    cleaned = true;
  });
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.deepEqual(terminations, ["SIGTERM"]);
  assert.equal(cleaned, false);
  child.emit("close", 0);
  assert.equal(await pending, 1, "timeout must never become a successful test");
  await cleanup;
  assert.equal(cleaned, true);
  t.mock.timers.tick(10_000);
  assert.deepEqual(terminations, ["SIGTERM"]);
});

test("unresponsive fixture escalates but still waits for close", async (t) => {
  const { child, pending, terminations } = fixture(t);
  t.mock.timers.tick(100);
  t.mock.timers.tick(5_000);
  assert.deepEqual(terminations, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);
  assert.equal(await pending, 1);
});

test("startup error fails without leaving timers", async (t) => {
  const { child, pending, terminations } = fixture(t);
  child.emit("error", new Error("fictional spawn failure"));
  assert.equal(await pending, 1);
  t.mock.timers.tick(10_000);
  assert.deepEqual(terminations, []);
});
