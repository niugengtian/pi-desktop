import { createHash } from "node:crypto";

export const CHECKPOINT_ENTRY_TYPE = "page-provider-checkpoint";
export const HANDOFF_ENTRY_TYPE = "page-provider-handoff";
export const UNCONFIRMED_TURN_MARKER = "PAGE_PROVIDER_TURN_UNCONFIRMED";

const DEFAULT_SUMMARY_LIMIT = 1_200;
const DEFAULT_HANDOFF_LIMIT = 12_000;

function compact(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function boundedSummary(value, limit = DEFAULT_SUMMARY_LIMIT) {
  const text = compact(value);
  if (text.length <= limit) return text;
  const suffix = "\n…[summary truncated]";
  return `${text.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

export function planConversationRoute(conversationId, failedTurnRetry = false) {
  const normalizedId = String(conversationId ?? "").trim();
  if (normalizedId) {
    return { conversationId: normalizedId, newConversation: false };
  }
  return { conversationId: undefined, newConversation: !failedTurnRetry };
}

export function shouldDedupeRetry(messages, currentText) {
  const key = compact(currentText).replace(/\s+/g, " ");
  if (!key || !Array.isArray(messages)) return false;
  const textOf = (message) => {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  };
  const isUnconfirmed = (message) =>
    message?.role === "assistant" &&
    (["error", "aborted"].includes(message?.stopReason) || textOf(message).includes(UNCONFIRMED_TURN_MARKER));
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUser = index;
      break;
    }
  }
  if (latestUser < 0) return false;
  if (messages.slice(latestUser + 1).some(isUnconfirmed)) {
    return true;
  }
  for (let index = latestUser - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (compact(textOf(message)).replace(/\s+/g, " ") !== key) continue;
    return messages.slice(index + 1, latestUser).some(isUnconfirmed);
  }
  return false;
}

export function sha256Text(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

export function checkpointFrom(value) {
  if (!value || typeof value !== "object") return undefined;
  const checkpoint = value;
  if (checkpoint.schemaVersion !== 1) return undefined;
  if (typeof checkpoint.taskId !== "string" || !checkpoint.taskId) return undefined;
  if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1) return undefined;
  if (typeof checkpoint.modelId !== "string" || !checkpoint.modelId) return undefined;
  if (typeof checkpoint.transcriptEntryId !== "string" || !checkpoint.transcriptEntryId) return undefined;
  return checkpoint;
}

export function createCheckpoint({
  taskId,
  sequence,
  transcriptEntryId,
  modelId,
  userText,
  assistantText,
  createdAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: 1,
    taskId,
    sequence,
    transcriptEntryId,
    modelId,
    inputHash: sha256Text(userText),
    outputHash: sha256Text(assistantText),
    requestSummary: boundedSummary(userText, 600),
    outcomeSummary: boundedSummary(assistantText, DEFAULT_SUMMARY_LIMIT),
    createdAt,
  };
}

export function verifiedOutcomeSummary(value) {
  const outcome = String(value ?? "");
  if (
    /(?:<|&lt;)[^\n>]*(?:DSML|invoke\s+name=|tool[_ -]?call)|recipient=(?:functions|multi_tool_use)\.|<\|[^\n]*tool/i.test(
      outcome,
    )
  ) {
    return "[Unverified action markup omitted: the web model described a tool call, but PI did not execute it.]";
  }
  return outcome;
}

function checkpointLine(checkpoint) {
  const request = checkpoint.requestSummary || "(no text request; see transcript entry)";
  const outcome = verifiedOutcomeSummary(checkpoint.outcomeSummary) || "(no text outcome; see transcript entry)";
  return [
    `### Checkpoint ${checkpoint.sequence} · ${checkpoint.modelId}`,
    `Transcript entry: ${checkpoint.transcriptEntryId}`,
    `Request: ${request}`,
    `Outcome: ${outcome}`,
  ].join("\n");
}

export function buildIncrementalHandoff({
  taskId,
  targetModelId,
  checkpoints,
  lastSyncedCheckpoint = 0,
  currentRequest,
  maxChars = DEFAULT_HANDOFF_LIMIT,
}) {
  const missing = checkpoints
    .filter((checkpoint) => checkpoint.sequence > lastSyncedCheckpoint)
    .sort((a, b) => a.sequence - b.sequence);
  if (missing.length === 0) return undefined;

  const throughCheckpoint = missing.at(-1).sequence;
  const header = [
    "[PI TASK HANDOFF]",
    `Task: ${taskId}`,
    `Target model: ${targetModelId}`,
    `Increment: checkpoint ${missing[0].sequence} through ${throughCheckpoint}`,
    "The PI transcript is authoritative. The following is a bounded incremental summary, not a replacement transcript.",
    "Before answering the current request, output this exact acknowledgement as the first line:",
    `PI_HANDOFF_ACK task=${taskId} checkpoint=${throughCheckpoint}`,
    "Then continue the task normally without repeating the handoff.",
    "",
  ].join("\n");
  const footer = ["", "[/PI TASK HANDOFF]", "", "## Current request", String(currentRequest ?? "").trim()].join("\n");

  const available = Math.max(0, maxChars - header.length - footer.length);
  const selected = [];
  let used = 0;
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    const line = checkpointLine(missing[index]);
    if (selected.length > 0 && used + line.length + 2 > available) break;
    selected.unshift(line);
    used += line.length + 2;
  }
  const omitted = missing.length - selected.length;
  const omission =
    omitted > 0
      ? `Earlier ${omitted} missing checkpoint(s) were omitted by the handoff size bound. Ask PI for a focused recovery if required.\n\n`
      : "";

  return {
    text: `${header}${omission}${selected.join("\n\n")}${footer}`,
    fromCheckpoint: missing[0].sequence,
    throughCheckpoint,
    checkpointCount: missing.length,
    includedCheckpointCount: selected.length,
  };
}

export function consumeHandoffAcknowledgement(markdown, taskId, checkpoint) {
  const source = String(markdown ?? "");
  const acknowledgement = `PI_HANDOFF_ACK task=${taskId} checkpoint=${checkpoint}`;
  const firstLineEnd = source.indexOf("\n");
  const firstLine = (firstLineEnd >= 0 ? source.slice(0, firstLineEnd) : source).trim().replace(/\\_/g, "_");
  const acknowledged = firstLine.toLowerCase() === acknowledgement.toLowerCase();
  return {
    acknowledged,
    markdown: acknowledged ? (firstLineEnd >= 0 ? source.slice(firstLineEnd + 1) : "").trimStart() : source,
    acknowledgement,
  };
}
