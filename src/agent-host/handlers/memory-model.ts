import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { DEFAULT_MEMORY_MODEL_SETTINGS, parseMemoryModelSettings } from "../../shared/memory-model";

const settingsPath = () => path.join(getAgentDir(), "task-memory.json");
const versionOf = (raw: string | null) =>
  raw === null ? "missing" : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
function readSnapshot() {
  const raw = existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : null;
  let settings;
  try {
    settings = raw === null ? DEFAULT_MEMORY_MODEL_SETTINGS : parseMemoryModelSettings(JSON.parse(raw));
  } catch {
    throw new RpcError({ code: "PARSE_ERROR", message: "Invalid task-memory.json; it was not overwritten." });
  }
  return { settings, version: versionOf(raw) };
}

export const memoryModelHandlers = {
  get: () => readSnapshot(),
  set: (params) => {
    const body = params as { settings: unknown; expectedVersion: string };
    let settings;
    try {
      settings = parseMemoryModelSettings(body.settings);
    } catch (error) {
      throw new RpcError({ code: "BAD_REQUEST", message: String(error) });
    }
    const previous = readSnapshot();
    if (body.expectedVersion !== previous.version)
      throw new RpcError({ code: "CONFLICT", message: "Memory settings changed; reload before saving." });
    const file = settingsPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const next = JSON.stringify(settings, null, 2) + "\n";
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, next, { mode: 0o600, flag: "wx" });
      if (readSnapshot().version !== previous.version)
        throw new RpcError({ code: "CONFLICT", message: "Memory settings changed during save." });
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* no temporary file */
      }
      throw error;
    }
    return { settings, version: versionOf(next) };
  },
  probe: async (params) => {
    const selected = String((params as { model?: unknown }).model ?? "");
    const split = selected.indexOf("/");
    if (split <= 0 || split === selected.length - 1 || selected.startsWith("opencli-page/")) {
      return { ok: false, error: "Choose a non-Web Pi model as the memory processor." };
    }
    const started = Date.now();
    try {
      const runtime = await ModelRuntime.create({
        modelsPath: path.join(getAgentDir(), "models.json"),
        allowModelNetwork: false,
      });
      const model = runtime.getModel(selected.slice(0, split), selected.slice(split + 1));
      if (!model) return { ok: false, error: "Model is not registered in Pi." };
      let local = false;
      try {
        local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(model.baseUrl).hostname);
      } catch {
        /* reject implicit remote endpoints */
      }
      if (!local) return { ok: false, error: "Memory processing only accepts a loopback model endpoint." };
      const auth = await runtime.getAuth(model);
      if (!auth) return { ok: false, error: "Model credentials are unavailable." };
      const response = await runtime.completeSimple(
        model,
        {
          messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
        },
        { timeoutMs: 20_000, maxRetries: 0, maxTokens: 16, cacheRetention: "none" },
      );
      if (response.stopReason !== "stop")
        return { ok: false, error: response.errorMessage ?? "Model probe failed.", latencyMs: Date.now() - started };
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) return { ok: false, error: "Model returned no text.", latencyMs: Date.now() - started };
      return { ok: true, latencyMs: Date.now() - started, responseText: text.slice(0, 100) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      };
    }
  },
} satisfies {
  get: NonNullable<ApiHandler["memoryModel.get"]>;
  set: NonNullable<ApiHandler["memoryModel.set"]>;
  probe: NonNullable<ApiHandler["memoryModel.probe"]>;
};
