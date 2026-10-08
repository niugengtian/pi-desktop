import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function readWarmModelSettings(agentDir = getAgentDir()) {
  const file = path.join(agentDir, "warm-model.json");
  const raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  const model: unknown = raw === null ? "deepseek/deepseek-flash" : JSON.parse(raw).model;
  if (typeof model !== "string" || !model.includes("/") || model.length > 512)
    throw new Error("Invalid warm-model.json");
  return { model, version: raw === null ? "missing" : createHash("sha256").update(raw).digest("hex") };
}
export function saveWarmModelSettings(model: string, expectedVersion: string, agentDir = getAgentDir()) {
  if (typeof model !== "string" || !model.includes("/") || model.length > 512) throw new Error("Invalid warm model");
  if (readWarmModelSettings(agentDir).version !== expectedVersion)
    throw new Error("Warm settings changed; reload before saving");
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, "warm-model.json");
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ model }, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return readWarmModelSettings(agentDir);
}
