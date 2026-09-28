import assert from "node:assert/strict";
import test from "node:test";
import { floatingMenuPosition } from "./floating-menu-position.ts";

const viewport = { viewportWidth: 828, viewportHeight: 682 };

test("places a measured session menu below its trigger when it fits", () => {
  assert.deepEqual(
    floatingMenuPosition({
      anchor: { top: 100, right: 300, bottom: 132 },
      menuWidth: 280,
      menuHeight: 180,
      ...viewport,
    }),
    { top: 136, left: 20 },
  );
});

test("places a measured session menu above a lower trigger", () => {
  assert.deepEqual(
    floatingMenuPosition({
      anchor: { top: 590, right: 300, bottom: 622 },
      menuWidth: 280,
      menuHeight: 240,
      ...viewport,
    }),
    { top: 346, left: 20 },
  );
});

test("clamps an oversized session menu inside the viewport", () => {
  assert.deepEqual(
    floatingMenuPosition({
      anchor: { top: 400, right: 250, bottom: 432 },
      menuWidth: 280,
      menuHeight: 666,
      ...viewport,
    }),
    { top: 8, left: 8 },
  );
});
