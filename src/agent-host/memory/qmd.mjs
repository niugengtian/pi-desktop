import { mkdirSync, lstatSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryResultFromPath, searchMemoryMarkdown } from "./markdown-store.mjs";

/** QMD's inline SDK configuration owns only this vault. BM25 never calls embed/query
 * or a model downloader. The optional module must be installed/configured explicitly.
 * Docs: https://github.com/tobi/qmd#sdk--library-usage */
export async function searchIndexedMemory(
  root,
  query,
  {
    limit = 10,
    modulePath = process.env.PI_DESKTOP_QMD_MODULE,
    load = (file) => import(pathToFileURL(file).href),
  } = {},
) {
  // Validate before an optional indexing backend receives input.
  const fallback = () => searchMemoryMarkdown(root, query, { limit });
  fallback();
  if (!modulePath) return { backend: "keyword", results: fallback(), warning: "QMD is not configured." };
  let store;
  try {
    if (!isAbsolute(modulePath)) throw new Error("QMD module must be an explicit absolute path.");
    const dir = resolve(root, ".index");
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error("Index directory is not regular.");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbPath = resolve(dir, "qmd.sqlite");
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (!lstatSync(file).isFile()) throw new Error("Index database is not a regular file.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const { createStore } = await load(modulePath);
    store = await createStore({
      dbPath,
      config: {
        collections: {
          "pi-hot": { path: resolve(root, "hot"), pattern: "mem-*.md" },
          "pi-warm": { path: resolve(root, "warm"), pattern: "mem-*.md" },
        },
      },
    });
    await store.update({ collections: ["pi-hot", "pi-warm"] });
    const hits = await store.searchLex(query, { limit, collections: ["pi-hot", "pi-warm"] });
    const results = hits.slice(0, limit).map((hit) => {
      const file = hit.file ?? hit.displayPath;
      const match = typeof file === "string" && file.match(/^(?:qmd:\/\/)?pi-(hot|warm)\/(mem-[a-f0-9]{24}\.md)$/);
      if (!match || !Number.isFinite(hit.score)) throw new Error("QMD returned an out-of-vault result.");
      return { ...memoryResultFromPath(root, `${match[1]}/${match[2]}`), score: hit.score };
    });
    return { backend: "qmd-bm25", results };
  } catch (error) {
    return { backend: "keyword", results: fallback(), warning: `QMD unavailable: ${String(error)}` };
  } finally {
    if (store) {
      try {
        await store.close();
      } catch {
        /* Preserve a safe keyword fallback if backend cleanup fails. */
      }
    }
  }
}
