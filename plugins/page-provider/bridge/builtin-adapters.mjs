import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Resolve only the public exports of the external OpenCLIApp runtime. */
export async function prepareBuiltinAdapter(openCliRoot, site, sourceRoot) {
  if (!["chatgpt", "deepseek"].includes(site)) throw new Error("Unsupported built-in Web adapter.");
  const manifest = JSON.parse(await readFile(join(openCliRoot, "package.json"), "utf8"));
  const imports = new Map();
  for (const name of ["registry", "errors", "utils"]) {
    const entry = manifest.exports?.[`./${name}`];
    if (typeof entry !== "string" || !entry.startsWith("./"))
      throw new Error(`OpenCLIApp lacks the required ${name} export. Update OpenCLIApp and try again.`);
    const target = resolve(openCliRoot, entry);
    if (!target.startsWith(resolve(openCliRoot) + sep)) throw new Error("Invalid OpenCLI export path.");
    await access(target);
    imports.set(`@jackwener/opencli/${name}`, pathToFileURL(target).href);
  }
  if (!sourceRoot) {
    const packaged = fileURLToPath(new URL("./web-adapters", import.meta.url));
    try {
      await access(join(packaged, site, "ask.js"));
      sourceRoot = packaged;
    } catch {
      sourceRoot = fileURLToPath(new URL("../../../extras/opencli-web-repair/clis", import.meta.url));
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-builtin-web-adapter-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    for (const file of ["ask.js", "utils.js"]) {
      const source = await readFile(join(sourceRoot, site, file), "utf8");
      const rebound = source.replace(
        /(['"])(@jackwener\/opencli\/(?:registry|errors|utils))\1/g,
        (_, _quote, specifier) => JSON.stringify(imports.get(specifier)),
      );
      await writeFile(join(directory, file), rebound, { mode: 0o600 });
    }
    return { adapterPath: join(directory, "ask.js"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
