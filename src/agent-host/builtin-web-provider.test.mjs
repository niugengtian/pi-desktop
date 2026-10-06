import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createDesktopAgentServices } from "./builtin-web-provider.ts";
import { prepareBuiltinAdapter } from "../../plugins/page-provider/bridge/builtin-adapters.mjs";
import { pathToFileURL } from "node:url";

async function fixture(t, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-first-install-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const settings = SettingsManager.inMemory();
  if (legacy) {
    const directory = join(root, "legacy-page-provider");
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "legacy-page-provider", pi: { extensions: ["extension.ts"] } }),
    );
    await writeFile(
      join(directory, "extension.ts"),
      `export default function(pi) {
      pi.registerCommand("page-provider-binding", {handler:async()=>{}});
      pi.registerCommand("legacy-page-provider-poison", {handler:async()=>{}});
      pi.registerProvider("opencli-page", {baseUrl:"page-provider://legacy",apiKey:"legacy",api:"opencli-page",models:[
        {id:"legacy-poison",name:"Legacy",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:10}
      ]});
    }`,
    );
    settings.setPackages([directory]);
  }
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const services = await createDesktopAgentServices({
    cwd,
    agentDir,
    settingsManager: settings,
    modelRuntime: runtime,
  });
  return { root, services, runtime };
}

for (const legacy of [false, true]) {
  test(`Web models load without manual installation (legacy plugin: ${legacy})`, async (t) => {
    const { services, runtime } = await fixture(t, legacy);
    assert.deepEqual(services.diagnostics, []);
    const web = runtime.getModels("opencli-page");
    assert.deepEqual(web.map((model) => model.id).sort(), ["chatgpt-web", "deepseek-chat", "deepseek-reasoner"]);
    assert.ok(web.every((model) => model.input.includes("image")));
    const extensions = services.resourceLoader.getExtensions().extensions;
    assert.equal(extensions.filter((extension) => extension.commands.has("page-provider-binding")).length, 1);
    assert.ok(!extensions.some((extension) => extension.commands.has("legacy-page-provider-poison")));
    await services.resourceLoader.reload();
    assert.equal(
      services.resourceLoader
        .getExtensions()
        .extensions.filter((extension) => extension.commands.has("page-provider-binding")).length,
      1,
    );
  });
}

test("built-in adapter uses external OpenCLI exports without user override files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-builtin-adapter-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "opencli");
  const source = join(root, "assets", "chatgpt");
  await mkdir(runtime);
  await mkdir(source, { recursive: true });
  await writeFile(
    join(runtime, "package.json"),
    JSON.stringify({
      type: "module",
      exports: { "./registry": "./registry.js", "./errors": "./errors.js", "./utils": "./utils.js" },
    }),
  );
  await writeFile(join(runtime, "registry.js"), "export const cli = (c) => c;");
  await writeFile(join(runtime, "errors.js"), "export class ArgumentError extends Error {}");
  await writeFile(join(runtime, "utils.js"), "export const htmlToMarkdown = s => s;");
  await writeFile(
    join(source, "ask.js"),
    `import {cli} from '@jackwener/opencli/registry'; import {value} from './utils.js'; export const askCommand=cli({value});`,
  );
  await writeFile(
    join(source, "utils.js"),
    `import {htmlToMarkdown} from '@jackwener/opencli/utils'; import {ArgumentError} from '@jackwener/opencli/errors'; export const value=htmlToMarkdown('BUILTIN_ONLY'); export {ArgumentError};`,
  );
  const { adapterPath, cleanup } = await prepareBuiltinAdapter(runtime, "chatgpt", join(root, "assets"));
  t.after(cleanup);
  assert.equal((await import(pathToFileURL(adapterPath).href)).askCommand.value, "BUILTIN_ONLY");
  assert.ok(!(await readFile(adapterPath, "utf8")).includes("@jackwener/opencli/registry"));
  await cleanup();
  await assert.rejects(readFile(adapterPath), { code: "ENOENT" });
});
