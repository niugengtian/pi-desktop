import type { SessionProjection } from "@earendil-works/pi-coding-agent";
export interface MemoryCandidate {
  id: string;
  sessionId: string;
  branchLeafId: string;
  entryId: string;
  role: string;
  text: string;
  sourceHash: string;
}
export declare function memoryCandidates(
  projection: SessionProjection,
  options: { sessionId: string; branchLeafId: string },
): MemoryCandidate[];
export declare function splitMemoryTiers(
  candidates: MemoryCandidate[],
  options?: { hotChars?: number },
): {
  hot: MemoryCandidate[];
  warmCandidates: MemoryCandidate[];
  hotChars: number;
  warmChars: number;
};
export interface MemoryCursor {
  fingerprint: string;
  entries: string[];
  unchanged: boolean;
  appended: MemoryCandidate[] | null;
}
export declare function memoryCursor(
  candidates: MemoryCandidate[],
  previous?: { fingerprint: string; entries: string[] } | null,
): MemoryCursor;
export declare function planMemoryDelivery(options: {
  from?: { provider: string; modelId: string } | null;
  to: { provider: string; modelId: string };
  estimatedTokens: number | null;
  contextWindow: number | null;
  threshold?: number;
}): { mode: "normal" | "staged"; reason: string; requiresPreview: boolean };
