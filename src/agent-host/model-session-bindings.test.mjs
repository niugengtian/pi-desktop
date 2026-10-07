import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readModelSessionBindings } from "./model-session-bindings.ts";

test("model session records expose per-account active and historical IDs without credentials", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-model-binding-"));
  const file = path.join(directory, "session.jsonl");
  const entry = (data) => JSON.stringify({ type: "custom", customType: "desktop-model-sessions", data });
  try {
    writeFileSync(
      file,
      [
        entry({ piSessionId: "other", records: [{ key: "wrong/model", id: "wrong" }] }),
        entry({
          piSessionId: "pi-id",
          active: "desktop-account-b/model",
          records: [
            { key: "desktop-account-a/model", id: "first-id", delivered: [], secret: "not exposed" },
            { key: "desktop-account-b/model", id: "second-id" },
          ],
          archived: [{ key: "desktop-account-b/model", id: "older-id" }],
        }),
        "{incomplete",
      ].join("\n"),
    );
    assert.deepEqual(readModelSessionBindings(file, "pi-id"), [
      { model: "desktop-account-a/model", id: "first-id", active: false, archived: false },
      { model: "desktop-account-b/model", id: "second-id", active: true, archived: false },
      { model: "desktop-account-b/model", id: "older-id", active: false, archived: true },
    ]);
    assert.deepEqual(readModelSessionBindings(file, "wrong-id"), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
