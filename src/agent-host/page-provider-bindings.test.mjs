import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPageProviderBindings } from "./page-provider-bindings.ts";

test("returns the newest safe Page Provider reference per model", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-page-provider-bindings-"));
  const file = path.join(directory, "session.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = (customType, modelId, conversationId, conversationUrl) =>
    JSON.stringify({
      type: "custom",
      customType,
      data: {
        modelId,
        remote: { site: "deepseek", mode: "chat", conversationId, conversationUrl },
        updatedAt: "2026-09-26T06:13:04.921Z",
      },
    });
  fs.writeFileSync(
    file,
    [
      "not-json",
      entry("page-provider-binding", "deepseek-chat", "old", "https://chat.deepseek.com/a/chat/s/old"),
      entry(
        "page-provider-binding-provisional",
        "deepseek-chat",
        "latest",
        "https://chat.deepseek.com/a/chat/s/latest",
      ),
      entry("page-provider-binding", "unsafe", "secret", "javascript:alert(1)"),
    ].join("\n"),
  );

  assert.deepEqual(readPageProviderBindings(file), [
    {
      modelId: "deepseek-chat",
      site: "deepseek",
      mode: "chat",
      conversationId: "latest",
      conversationUrl: "https://chat.deepseek.com/a/chat/s/latest",
      updatedAt: "2026-09-26T06:13:04.921Z",
      provisional: true,
    },
    {
      modelId: "unsafe",
      site: "deepseek",
      mode: "chat",
      conversationId: "secret",
      updatedAt: "2026-09-26T06:13:04.921Z",
      provisional: false,
    },
  ]);
});
