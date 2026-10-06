import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuiltinAdapter } from "../../plugins/page-provider/bridge/builtin-adapters.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-rendered-prompt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      exports: {
        "./registry": "./dist/src/registry.js",
        "./errors": "./dist/src/errors.js",
        "./utils": "./dist/src/utils.js",
      },
    }),
  );
  await writeFile(
    join(root, "dist/src/registry.js"),
    "export const cli=c=>c; export const Strategy={COOKIE:'cookie'};",
  );
  await writeFile(
    join(root, "dist/src/errors.js"),
    "export class ArgumentError extends Error {} export class AuthRequiredError extends Error {} export class CommandExecutionError extends Error {} export class TimeoutError extends Error {}",
  );
  await writeFile(join(root, "dist/src/utils.js"), "export const htmlToMarkdown=s=>s;");
  const built = await prepareBuiltinAdapter(root, "chatgpt");
  t.after(built.cleanup);
  return import(pathToFileURL(join(dirname(built.adapterPath), "utils.js")));
}

test("built-in ChatGPT matches reconstructed Markdown punctuation without accepting a different request", async (t) => {
  const utils = await fixture(t);
  const prompt =
    "[PI TIERED CONTEXT v1] " +
    JSON.stringify({ agreements: "Use `opencli`", hot: [{ content: "Find `rg` in `/work/project`" }] });
  const messages = [
    { Role: "User", Text: prompt.replaceAll("`", ""), PromptText: prompt },
    { Role: "Assistant", Text: "Completed reply" },
  ];
  assert.equal(utils.findExistingChatGPTResponse(messages, prompt), "Completed reply");
  assert.equal(utils.findExistingChatGPTResponse(messages, prompt.replace("`rg`", "rg")), "");
  assert.equal(utils.findExistingChatGPTResponse(messages, "Find `rg`"), "");
});

test("reply matching never crosses an intervening user request", async (t) => {
  const utils = await fixture(t);
  const messages = [
    { Role: "User", Text: "original" },
    { Role: "User", Text: "different" },
    { Role: "Assistant", Text: "Reply to different" },
  ];
  assert.equal(utils.findExistingChatGPTResponse(messages, "original"), "");
  assert.equal(utils.getChatGPTResponsePairCounts(messages, "original").size, 0);
});

test("read-only wait recovers a completed rendered prompt pair and does not accept a baseline reply", async (t) => {
  const utils = await fixture(t);
  const prompt = "Use `rg` " + "long context ".repeat(1200);
  const rows = [
    { role: "User", text: prompt.replaceAll("`", ""), promptText: prompt },
    { role: "Assistant", text: "Recovered", html: "" },
  ];
  let sleeps = 0;
  const page = {
    sleep: async () => {
      sleeps++;
    },
    evaluate: async (script) => {
      if (script === "window.location.href") return "https://chatgpt.com/c/test";
      if (script.includes("Stop generating")) return false;
      return rows;
    },
  };
  assert.equal(
    await utils.waitForChatGPTResponse(page, 0, prompt, 10, { conversationUrl: "https://chatgpt.com/c/test" }),
    "Recovered",
  );
  assert.equal(sleeps, 3);
  const baseline = utils.getChatGPTResponsePairCounts(await utils.getVisibleMessages(page), prompt);
  t.mock.method(
    Date,
    "now",
    (() => {
      let now = 0;
      return () => (now += 1000);
    })(),
  );
  await assert.rejects(utils.waitForChatGPTResponse(page, 2, prompt, 4, { baselinePairCounts: baseline }));
});
