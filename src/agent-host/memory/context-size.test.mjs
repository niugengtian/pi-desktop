import { test } from "node:test";
import assert from "node:assert/strict";
import { contextSizePlan } from "./context-size.ts";
const model = { contextWindow: 272000, maxTokens: 128000 };
const input = (n) => [{ role: "user", content: "x".repeat(n), timestamp: 1 }];
test("small native, medium hot/handoff and large warm decisions preserve input and use target capacity", () => {
  for (const [length, mode] of [
    [400, "native"],
    [20000, "hot-handoff"],
    [80000, "warm"],
  ]) {
    const source = input(length),
      before = JSON.stringify(source);
    const plan = contextSizePlan(source, model);
    assert.equal(plan.mode, mode);
    assert.equal(plan.small, 4000);
    assert.equal(plan.large, 16000);
    assert.equal(JSON.stringify(source), before);
  }
  const smaller = contextSizePlan(input(20000), { contextWindow: 8192, maxTokens: 2048 });
  assert.equal(smaller.mode, "warm");
  assert.ok(smaller.small < 4000 && smaller.large < 16000);
});
