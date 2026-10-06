import { createHash } from "node:crypto";
export const WEB_CONTRACT = "pi-tiered-web-1";
export const DELIVERY_ENTRY_TYPE = "page-provider-tiered-delivery";
export const hashText = (text) => createHash("sha256").update(text, "utf8").digest("hex");
export function acceptTieredPayload(payload, expected, taskId, modelId) {
  const clean = JSON.parse(JSON.stringify(payload ?? expected));
  if (
    JSON.stringify(clean) !== JSON.stringify(expected) ||
    clean.schema !== WEB_CONTRACT ||
    clean.sessionId !== taskId ||
    clean.modelId !== modelId ||
    clean.promptHash !== hashText(clean.text) ||
    !clean.text.trim() ||
    typeof clean.newConversation !== "boolean" ||
    clean.dedupe !== false ||
    !Array.isArray(clean.attachments) ||
    clean.attachments.length > 8
  )
    throw new Error("Tiered Web final text/target changed; nothing sent.");
  return clean;
}
export function requireTieredReceipt(result, payload) {
  const receipt = result.receipt;
  if (
    receipt?.schema !== WEB_CONTRACT ||
    receipt.turnId !== result.turnId ||
    receipt.promptHash !== payload.promptHash ||
    receipt.responseHash !== hashText(result.markdown) ||
    receipt.evidence !== "adapter-exact-prompt-pair" ||
    JSON.stringify(receipt.remote) !== JSON.stringify(result.remote)
  )
    throw new Error("Tiered Web result has no matching delivery receipt.");
  return receipt;
}
