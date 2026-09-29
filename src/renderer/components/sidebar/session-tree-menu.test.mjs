import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionTree.tsx", import.meta.url), "utf8");

test("session action menu measures its rendered size after async content changes", () => {
  assert.match(source, /useLayoutEffect\(\(\) => \{/);
  assert.match(source, /menuWidth: menu\.offsetWidth/);
  assert.match(source, /menuHeight: menu\.offsetHeight/);
  assert.match(source, /\[actionsOpen, providerBindings\]/);
  assert.doesNotMatch(source, /estimatedHeight/);
});

test("session action menu is above application panes but below modal dialogs", () => {
  assert.match(source, /ref=\{actionsMenuRef\}[\s\S]*?zIndex: 500/);
});

test("session identifiers and URLs use the native desktop clipboard", () => {
  assert.match(source, /await window\.piBridge\.writeClipboardText\(text\)/);
  assert.doesNotMatch(source, /navigator\.clipboard\.writeText/);
});
