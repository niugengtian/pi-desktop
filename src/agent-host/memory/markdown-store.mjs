import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TIERS = new Set(["hot", "warm"]);

function safeId(id) {
  if (typeof id !== "string" || !SLUG.test(id)) throw new Error("Invalid memory record ID.");
  return id;
}
function safeTier(tier) {
  if (!TIERS.has(tier)) throw new Error("Only hot and warm derived Markdown records may be written.");
  return tier;
}
function scalar(value) {
  return JSON.stringify(String(value ?? ""));
}
function cell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}
function relativeRecordPath(tier, id) {
  return `${safeTier(tier)}/${safeId(id)}.md`;
}

export function memoryRecordId(sessionId, sourceEntryIds) {
  if (
    typeof sessionId !== "string" ||
    !Array.isArray(sourceEntryIds) ||
    sourceEntryIds.length === 0 ||
    sourceEntryIds.some((id) => typeof id !== "string" || !id)
  )
    throw new Error("A session and source entry IDs are required.");
  return `mem-${sha256(JSON.stringify([sessionId, sourceEntryIds])).slice(0, 24)}`;
}

export function renderMemoryMarkdown(record) {
  const { id, tier, title, summary, sources, updatedAt, modelId = "", keywords = [] } = record;
  safeId(id);
  safeTier(tier);
  if (typeof title !== "string" || !title.trim() || /[\r\n]/.test(title))
    throw new Error("Memory title must be one line.");
  if (typeof summary !== "string" || !summary.trim() || summary.length > 4_000)
    throw new Error("Memory summary exceeds its budget.");
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some(
      (source) =>
        !source ||
        typeof source.sessionId !== "string" ||
        !source.sessionId ||
        typeof source.branchLeafId !== "string" ||
        !source.branchLeafId ||
        typeof source.entryId !== "string" ||
        !source.entryId ||
        !/^[a-f0-9]{64}$/.test(source.sourceHash),
    )
  ) {
    throw new Error("Memory sources must include session, branch, entry and SHA-256 provenance.");
  }
  if (!Array.isArray(keywords) || keywords.some((key) => typeof key !== "string" || key.length > 80))
    throw new Error("Invalid keywords.");
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid update timestamp.");
  const rows = sources.map(
    (source) =>
      `| ${cell(source.sessionId)} | ${cell(source.branchLeafId)} | ${cell(source.entryId)} | ${cell(source.sourceHash)} |`,
  );
  // JSON quoted frontmatter values are valid YAML scalars and cannot inject keys.
  return `---\nid: ${scalar(id)}\ntier: ${scalar(tier)}\nupdated: ${scalar(date.toISOString())}\nmodel: ${scalar(modelId)}\nkeywords: [${keywords.map(scalar).join(", ")}]\n---\n\n# ${title}\n\n${summary.trim()}\n\n## Sources\n\n| Pi session | Branch leaf | Entry ID | Source SHA-256 |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

function files(root, tier, id) {
  const base = resolve(root);
  const relative = relativeRecordPath(tier, id);
  const file = resolve(base, relative);
  if (!file.startsWith(base + sep)) throw new Error("Record must remain in the memory root.");
  return { base, file, relative };
}

/** Readable Markdown is authoritative. Never silently overwrite a human change. */
export function writeMemoryMarkdown(root, record, expectedHash = null) {
  const { file, relative } = files(root, record.tier, record.id);
  const markdown = renderMemoryMarkdown(record);
  const present = existsSync(file);
  if (expectedHash !== null && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)))
    throw new Error("Invalid expected hash.");
  if (present) {
    if (!lstatSync(file).isFile()) throw new Error("Memory destination is not a regular file.");
    const current = readFileSync(file, "utf8");
    if (expectedHash === null || sha256(current) !== expectedHash)
      throw new Error("Memory file changed or lacks an expected revision; manual edits were preserved.");
    if (current === markdown) return { path: relative, hash: sha256(current), unchanged: true };
  } else if (expectedHash !== null) {
    throw new Error("Memory file was removed; refusing to recreate it as an update.");
  }
  mkdirSync(resolve(root, record.tier), { recursive: true, mode: 0o700 });
  // Exclusive temp creation; do not follow a symlink as an output destination.
  const tmp = `${file}.${process.pid}.${sha256(markdown).slice(0, 8)}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, markdown, "utf8");
    closeSync(fd);
    fd = undefined;
    if (present && (!lstatSync(file).isFile() || sha256(readFileSync(file, "utf8")) !== expectedHash))
      throw new Error("Memory file changed during update; manual edits were preserved.");
    if (!present && existsSync(file)) throw new Error("Memory file appeared during creation; refusing to replace it.");
    renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* no temporary file */
    }
    throw error;
  }
  return { path: relative, hash: sha256(markdown), unchanged: false };
}

export function searchMemoryMarkdown(root, query, { limit = 10 } = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 200)
    throw new Error("Search query must be 1–200 characters.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid result limit.");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u);
  const results = [];
  for (const tier of ["hot", "warm"]) {
    const dir = resolve(root, tier);
    if (!existsSync(dir)) continue;
    // No network or indexing service is required for the keyword fallback.
    for (const name of requireDirectoryFiles(dir)) {
      if (!/^mem-[a-f0-9]{24}\.md$/.test(name)) continue;
      const id = name.slice(0, -3);
      const text = readFileSync(join(dir, name), "utf8");
      const body = text.toLocaleLowerCase();
      const score = terms.reduce((value, term) => value + (body.includes(term) ? 1 : 0), 0);
      if (!score) continue;
      const title = text.match(/^# (.+)$/m)?.[1] ?? id;
      results.push({ id, tier, title, score, path: `${tier}/${name}`, hash: sha256(text) });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

function requireDirectoryFiles(dir) {
  return readdirSync(dir).filter((name) => {
    const file = join(dir, name);
    return lstatSync(file).isFile(); // refuse symlinks to outside the vault
  });
}

export function openMemoryMarkdown(root, result) {
  if (!result || typeof result !== "object") throw new Error("Select a search result first.");
  const { file } = files(root, result.tier, result.id);
  if (!lstatSync(file).isFile()) throw new Error("Memory file is not a regular file.");
  const text = readFileSync(file, "utf8");
  if (sha256(text) !== result.hash) throw new Error("Memory changed after search; search again before opening.");
  return text;
}
