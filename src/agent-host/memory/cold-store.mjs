import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const hash = (entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");
function branch(file, leaf) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
    throw new Error("Cold source must be a bounded regular JSONL file.");
  const manager = SessionManager.open(file);
  if (!manager.getEntry(leaf)) throw new Error("Cold branch leaf no longer exists.");
  return { sessionId: manager.getSessionId(), entries: manager.getBranch(leaf) };
}
function eligible(entry) {
  if (entry.type !== "message") return false;
  const m = entry.message;
  return (
    ["user", "assistant", "toolResult"].includes(m.role) &&
    !(m.role === "assistant" && m.stopReason && m.stopReason !== "stop")
  );
}
function text(entry) {
  const value = entry.message.content;
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : "";
}
/** Explicit, LOCAL search of one session's ancestor path, including pre-compaction messages. */
export function searchColdMemory(sessionFile, query, { branchLeafId, limit = 10 } = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("Invalid cold query.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid cold result limit.");
  const source = branch(sessionFile, branchLeafId);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u);
  const results = [];
  for (const entry of source.entries) {
    if (!eligible(entry)) continue;
    const body = text(entry);
    if (body.includes("PAGE_PROVIDER_TURN_UNCONFIRMED")) continue;
    const score = terms.filter((term) => body.toLocaleLowerCase().includes(term)).length;
    if (score)
      results.push({
        tier: "cold",
        sessionFile,
        sessionId: source.sessionId,
        branchLeafId,
        entryId: entry.id,
        hash: hash(entry),
        score,
        title: `${entry.message.role} · ${entry.id}`,
      });
  }
  return results.sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId)).slice(0, limit);
}
/** No remote delivery: validate branch membership and revision before opening the authoritative entry. */
export function openColdMemory(result) {
  if (result?.tier !== "cold") throw new Error("Select a cold result first.");
  const source = branch(result.sessionFile, result.branchLeafId);
  const entry = source.entries.find((item) => item.id === result.entryId);
  if (source.sessionId !== result.sessionId || !entry || !eligible(entry) || hash(entry) !== result.hash)
    throw new Error("Cold source changed; search again.");
  return structuredClone(entry);
}
