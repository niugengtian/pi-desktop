import type {
  ReadonlySessionManager,
  SessionBeforeCompactEvent,
  CompactionResult,
  CompactionEntry,
} from "@earendil-works/pi-coding-agent";
export const WARM_SCHEMA: string;
export const LONG_WARM_SCHEMA: string;
export const SUMMARY_WARM_SCHEMA: string;
export const SUMMARY_WARM_INSTRUCTIONS: string;
export const LONG_WARM_INSTRUCTIONS: string;
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
  notes?: Array<{ sourceHash: string; summary: string }>;
  sourcePath?: string;
  archive?: { sourcePath: string; omittedSourceIds: string[] };
}
export interface WarmPlan {
  schema: string;
  instructions: string;
  sourcePath: string;
  sessionId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  sourceHash: string;
  payload: string;
  maxSummaryChars?: number;
  previousSummary?: string;
  segment?: { index: number; count: number; deltaHash: string };
  records: Array<{
    sourceId: string;
    entryId: string;
    sourceHash: string;
    role: string;
    toolError: boolean | null;
    text: string;
    closedTools?: boolean;
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

export const WARM_SEGMENT_BYTES: number;
export function splitWarmPlan(plan: WarmPlan): WarmPlan[];
export function mergeWarmAnswers(plan: WarmPlan, segments: WarmPlan[], answers: string[]): CompactionResult;

export function buildWarmConsolidation(plan: WarmPlan, candidate: CompactionResult): WarmPlan;
export function applyWarmConsolidation(
  plan: WarmPlan,
  candidate: CompactionResult,
  consolidation: WarmPlan,
  answer: string,
): CompactionResult;
