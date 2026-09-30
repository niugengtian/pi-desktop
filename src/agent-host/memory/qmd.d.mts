import type { MemorySearchResult } from "./markdown-store.mjs";
export declare function searchIndexedMemory(
  root: string,
  query: string,
  options?: {
    limit?: number;
    modulePath?: string;
  },
): Promise<{ backend: "keyword" | "qmd-bm25"; results: MemorySearchResult[]; warning?: string }>;
