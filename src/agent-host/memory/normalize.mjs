const TRANSPORTS = [
  ["[PI TASK HANDOFF]", "[/PI TASK HANDOFF]"],
  ["[PI WEB CONTEXT]", "[/PI WEB CONTEXT]"],
  ["[PI APPROVED MEMORY HANDOFF v1]", "[/PI APPROVED MEMORY HANDOFF v1]"],
];

/** Strip only recognized, framed transport envelopes. Never ingest a summary of
 * a summary plus its embedded history. Unknown/broken frames fail closed. */
export function canonicalMemoryText(value, role = "user") {
  let text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  for (let depth = 0; depth < 8; depth++) {
    const frame = TRANSPORTS.find(([start]) => text.startsWith(start));
    if (!frame) return text;
    if (role !== "user") return ""; // model echoed protocol, not new task progress
    const closing = text.indexOf(frame[1]);
    const suffix = closing >= 0 ? text.slice(closing + frame[1].length).trimStart() : "";
    if (!suffix.startsWith("## Current request\n"))
      throw new Error("Malformed memory transport; no history was promoted.");
    text = suffix.slice("## Current request\n".length).trim();
  }
  throw new Error("Recursive memory transport exceeds the nesting limit.");
}

export function normalizeMemorySummary(value) {
  if (TRANSPORTS.some(([start]) => value.includes(start)))
    throw new Error("Memory model echoed a transport envelope; no summary was promoted.");
  return deduplicateMemoryParagraphs(value);
}

/** Repeated paragraphs are transport/log repetition, not additional facts.
 * This transforms only derived summarizer input; raw JSONL and request bodies
 * retain their exact text and provenance hashes. */
export function deduplicateMemoryParagraphs(value) {
  const seen = new Set();
  return value
    .trim()
    .split(/\n\s*\n/u)
    .filter((paragraph) => {
      const key = paragraph.replace(/\s+/gu, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n");
}

export function memoryTextKey(role, text) {
  return JSON.stringify([role, text.replace(/\s+/gu, " ").trim()]);
}
