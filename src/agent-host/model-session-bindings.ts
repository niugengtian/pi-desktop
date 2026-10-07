import { readFileSync } from "node:fs";

export interface ModelSessionBindingSummary {
  model: string;
  id: string;
  active: boolean;
  archived: boolean;
}

function safeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

/** Return only model identity references, never transcript content or credentials. */
export function readModelSessionBindings(filePath: string, piSessionId: string): ModelSessionBindingSummary[] {
  let saved: Record<string, unknown> | undefined;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "custom" && entry.customType === "desktop-model-sessions") {
        saved = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : undefined;
      }
    } catch {
      // An incomplete final write must not hide previously saved bindings.
    }
  }
  if (saved?.piSessionId !== piSessionId) return [];
  const active = safeString(saved.active, 512);
  const result: ModelSessionBindingSummary[] = [];
  for (const [rows, archived] of [
    [saved.records, false],
    [saved.archived, true],
  ] as const) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const model = safeString(row.key, 512);
      const id = safeString(row.id, 256);
      if (!model || !id || !model.includes("/")) continue;
      result.push({ model, id, active: !archived && model === active, archived });
    }
  }
  return result;
}
