import { readFileSync } from "node:fs";

const BINDING_TYPES = new Set(["page-provider-binding", "page-provider-binding-provisional"]);

export interface PageProviderBindingSummary {
  modelId: string;
  site: string;
  mode?: string;
  conversationId: string;
  conversationUrl?: string;
  updatedAt?: string;
  provisional: boolean;
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function safeConversationUrl(value: unknown): string | undefined {
  const raw = safeString(value, 2048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Read only safe remote references. Transcript text and authentication data are never returned. */
export function readPageProviderBindings(filePath: string): PageProviderBindingSummary[] {
  const bindings = new Map<string, PageProviderBindingSummary>();
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "custom" || typeof entry.customType !== "string" || !BINDING_TYPES.has(entry.customType)) {
      continue;
    }
    const data = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : null;
    const remote = data?.remote && typeof data.remote === "object" ? (data.remote as Record<string, unknown>) : null;
    const modelId = safeString(data?.modelId, 256);
    const site = safeString(remote?.site, 64);
    const conversationId = safeString(remote?.conversationId, 256);
    if (!modelId || !site || !conversationId) continue;
    const mode = safeString(remote?.mode, 64);
    const conversationUrl = safeConversationUrl(remote?.conversationUrl);
    const updatedAt = safeString(data?.updatedAt, 64);
    bindings.set(modelId, {
      modelId,
      site,
      conversationId,
      ...(mode ? { mode } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      provisional: entry.customType === "page-provider-binding-provisional",
    });
  }
  return [...bindings.values()];
}
