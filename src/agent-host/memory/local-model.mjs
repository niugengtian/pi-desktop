import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

export function isLoopbackModel(model) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(model?.baseUrl).hostname); }
  catch { return false; }
}

/** Create a processor for one update. Health is checked once per candidate before summarizing. */
export async function createLocalMemoryRunner({ signal, runtime: providedRuntime } = {}) {
  const runtime = providedRuntime ?? await ModelRuntime.create({
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  });
  const probed = new Set();
  return async (id, prompt) => {
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) throw new Error("Invalid memory model ID.");
    const model = runtime.getModel(id.slice(0, slash), id.slice(slash + 1));
    if (!model) throw new Error(`Memory model ${id} is not registered in Pi.`);
    if (!isLoopbackModel(model)) throw new Error(`Memory model ${id} must use a loopback endpoint.`);
    if (!await runtime.getAuth(model)) throw new Error(`Memory model ${id} has no configured credentials.`);
    const invoke = async (text, maxTokens, timeoutMs) => {
      const result = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: `/no_think\n${text}`, timestamp: Date.now() }],
      }, { signal, timeoutMs, maxRetries: 0, maxTokens, cacheRetention: "none" });
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Memory model ${id} failed.`);
      const answer = result.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      if (!answer) throw new Error(`Memory model ${id} returned no text.`);
      return answer;
    };
    if (!probed.has(id)) {
      await invoke("Reply with OK only.", 16, 20_000);
      probed.add(id);
    }
    return invoke(prompt, 768, 120_000);
  };
}
