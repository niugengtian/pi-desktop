import type {
  ReadonlySessionManager,
  SessionBeforeCompactEvent,
  CompactionResult,
  CompactionEntry,
} from "@earendil-works/pi-coding-agent";
export const WARM_SCHEMA: string;
export const WARM_INSTRUCTIONS: string;
export interface WarmFact {
  sourceId: string;
  sourceHash: string;
  quote: string;
  role: string;
  toolError: boolean | null;
}
export interface WarmRecord {
  schema: string;
  version: number;
  parentEntryId: string | null;
  parentSummaryHash: string | null;
  sourceHash: string;
  delta: Array<{ sourceId: string; sourceHash: string }>;
  facts: WarmFact[];
  opaqueSummary: string;
  summaryHash: string;
  review: string;
  semanticCompleteness: string;
}
export interface WarmPlan {
  schema: string;
  sessionId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  sourceHash: string;
  payload: string;
  records: Array<{
    sourceId: string;
    entryId: string;
    sourceHash: string;
    role: string;
    toolError: boolean | null;
    text: string;
  }>;
  readFiles: string[];
  modifiedFiles: string[];
  parentEntryId: string | null;
  parentSummaryHash: string | null;
  parent?: WarmRecord;
  opaqueSummary: string;
}
export function readWarmRecord(compaction?: CompactionEntry): WarmRecord | undefined;
export function buildWarmPlan(
  manager: ReadonlySessionManager,
  preparation: SessionBeforeCompactEvent["preparation"],
): WarmPlan;
export function validateWarmAnswer(plan: WarmPlan, answer: string): CompactionResult;
