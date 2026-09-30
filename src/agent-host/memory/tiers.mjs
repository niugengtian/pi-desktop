import { createHash } from "node:crypto";
import { canonicalMemoryText, failedMemoryMessages } from "./normalize.mjs";

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const MAX_CANDIDATE_CHARS = 120_000;
const MAX_HOT_CHARS = 12_000;

/** Only Pi's projected, context-visible path is eligible for promotion. */
export function memoryCandidates(projection, { sessionId, branchLeafId }) {
  if (!sessionId || !branchLeafId || !Array.isArray(projection?.entries))
    throw new Error("A projected Pi branch and its provenance are required.");
  const failed = failedMemoryMessages(projection.entries.flatMap((entry) => entry.messages ?? []));
  const candidates = [];
  let totalChars = 0;
  for (const item of projection.entries) {
    const entry = item?.sourceEntry;
    if (!entry?.id || !Array.isArray(item.messages)) throw new Error("Invalid Pi projection; no memory was promoted.");
    for (const message of item.messages) {
      if (failed.has(message)) continue;
      if (!["user", "assistant", "toolResult", "compactionSummary", "branchSummary"].includes(message?.role)) continue;
      if (message.role === "assistant" && message.stopReason && message.stopReason !== "stop") continue;
      const content = message.content ?? message.summary ?? message.text;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part?.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("\n")
            : "";
      if (!text || text.includes("PAGE_PROVIDER_TURN_UNCONFIRMED")) continue;
      const cleanText = canonicalMemoryText(text, message.role);
      if (!cleanText) continue;
      totalChars += cleanText.length;
      if (totalChars > MAX_CANDIDATE_CHARS)
        throw new Error("Memory source exceeds the configured limit; nothing was promoted.");
      candidates.push({
        id: `${sessionId}:${entry.id}`,
        sessionId,
        branchLeafId,
        entryId: entry.id,
        role: message.role,
        text: cleanText,
        sourceHash: digest(text),
      });
    }
  }
  return candidates;
}

/** Hot is a bounded, complete suffix; older items are references, not a silent excerpt of raw history. */
export function splitMemoryTiers(candidates, { hotChars = MAX_HOT_CHARS } = {}) {
  if (!Number.isSafeInteger(hotChars) || hotChars < 0) throw new Error("Invalid hot memory budget.");
  let hotSize = 0;
  let boundary = candidates.length;
  while (boundary > 0) {
    let start = boundary - 1;
    while (start > 0 && candidates[start - 1].entryId === candidates[boundary - 1].entryId) start--;
    const size = candidates.slice(start, boundary).reduce((sum, item) => sum + item.text.length, 0);
    if (hotSize + size > hotChars) break;
    hotSize += size;
    boundary = start;
  }
  return {
    hot: candidates.slice(boundary),
    warmCandidates: candidates.slice(0, boundary),
    hotChars: hotSize,
    warmChars: candidates.slice(0, boundary).reduce((sum, item) => sum + item.text.length, 0),
  };
}

/** A deterministic ledger: never treat a changed branch as an append-only continuation. */
export function memoryCursor(candidates, previous = null) {
  const ids = candidates.map(({ id, sourceHash }) => `${id}:${sourceHash}`);
  const fingerprint = digest(ids.join("\n"));
  const previousIds = previous?.entries;
  const appendOnly =
    Array.isArray(previousIds) &&
    previousIds.length <= ids.length &&
    previousIds.every((value, index) => value === ids[index]);
  return {
    fingerprint,
    entries: ids,
    unchanged: previous?.fingerprint === fingerprint,
    appended: appendOnly ? candidates.slice(previousIds.length) : null,
  };
}

export function planMemoryDelivery({ from, to, estimatedTokens, contextWindow, threshold = 0.8 }) {
  if (!to?.provider || !to?.modelId) throw new Error("Target model is required.");
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error("Invalid context threshold.");
  const switched = Boolean(from && (from.provider !== to.provider || from.modelId !== to.modelId));
  // Unknown usage cannot prove the history fits the target model. Never infer safety.
  const withinBudget =
    Number.isFinite(estimatedTokens) &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    estimatedTokens < contextWindow * threshold;
  return switched || !withinBudget
    ? { mode: "staged", reason: switched ? "model-switch" : "budget-or-unknown", requiresPreview: true }
    : { mode: "normal", reason: "same-model-within-budget", requiresPreview: false };
}
