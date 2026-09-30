import type { SessionEntry } from "@earendil-works/pi-coding-agent";
export interface ColdMemoryResult {
  tier: "cold";
  sessionFile: string;
  sessionId: string;
  branchLeafId: string;
  entryId: string;
  hash: string;
  score: number;
  title: string;
}
export declare function searchColdMemory(
  sessionFile: string,
  query: string,
  options: { branchLeafId: string; limit?: number },
): ColdMemoryResult[];
export declare function openColdMemory(result: ColdMemoryResult): SessionEntry;
