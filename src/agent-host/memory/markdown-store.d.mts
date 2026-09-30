export declare function memoryRecordId(sessionId: string, sourceEntryIds: string[]): string;
export interface MemorySearchResult {
  id: string;
  tier: "hot" | "warm";
  title: string;
  score: number;
  path: string;
  hash: string;
}
export declare function searchMemoryMarkdown(
  root: string,
  query: string,
  options?: { limit?: number },
): MemorySearchResult[];
export declare function memoryResultFromPath(root: string, relative: string): MemorySearchResult;
export declare function assertMemoryDirectory(dir: string): void;
export declare function openMemoryMarkdown(root: string, result: MemorySearchResult): string;
export declare function writeMemoryMarkdown(
  root: string,
  record: unknown,
  expectedHash?: string | null,
): {
  path: string;
  hash: string;
  unchanged: boolean;
};
