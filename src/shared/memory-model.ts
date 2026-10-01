export interface MemoryModelSettings {
  enabled: boolean;
  primary: string;
  fallback: string | null;
}

export const DEFAULT_MEMORY_MODEL_SETTINGS: MemoryModelSettings = {
  enabled: true,
  primary: "ollama-local/pi-qwen3-4b-summary:q4km",
  fallback: null,
};

function modelId(value: unknown, optional: boolean): string | null {
  if (optional && (value === null || value === "")) return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new Error("Select a model as provider/model-id.");
  }
  return value;
}

export function parseMemoryModelSettings(value: unknown): MemoryModelSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid memory model settings.");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.enabled !== "boolean") throw new Error("Memory model enabled must be a boolean.");
  const primary = modelId(source.primary, false)!;
  const fallback = modelId(source.fallback, true);
  if (fallback === primary) throw new Error("Fallback must differ from primary.");
  if (fallback === "deepseek/deepseek-flash" || (primary === "deepseek/deepseek-flash" && fallback)) {
    throw new Error("Remote Flash memory requires no fallback; remote providers cannot be implicit backups.");
  }
  return { enabled: source.enabled, primary, fallback };
}
