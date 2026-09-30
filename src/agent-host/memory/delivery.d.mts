import type { Model, Api, TranscriptContext } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MemoryLedger } from "./compile.mjs";
export const WEB_HANDOFF_PROMPT: string;
export const WEB_HANDOFF_MARKER: string;
export declare function isWebMemoryModel(model: { provider: string; api?: string }): boolean;
export declare function latestMemoryLedger(entries: SessionEntry[]): MemoryLedger | null;
export declare function prepareMemoryDelivery(options: {
  model: Model<Api>;
  context: TranscriptContext;
  from: { provider: string; modelId: string } | null;
  estimatedTokens: number | null;
  entries: SessionEntry[];
  branchLeafId: string;
  sessionId: string;
  root: string;
  ledger: MemoryLedger | null;
  signal?: AbortSignal;
  web?: boolean;
  approve: (preview: { target: string; reason: string; fingerprint: string; text: string }) => Promise<boolean>;
}): Promise<{
  context: TranscriptContext;
  plan: { mode: string; reason: string; requiresPreview: boolean };
  receipt: {
    target: string;
    fingerprint: string;
    promptHash: string;
    requestText: string;
    recoverOnly: boolean;
    sourceFingerprint: string | null;
  } | null;
}>;
