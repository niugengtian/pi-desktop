import type { MemoryModelSettings } from "../../shared/memory-model";

export interface TaskMemoryResult {
  source: string;
  sourceHash: string;
  summary: string;
  modelId: string;
  sourceChars: number;
  summaryChars: number;
}
export declare const MAX_MEMORY_SOURCE_CHARS: number;
export declare const MAX_MEMORY_SUMMARY_CHARS: number;
export declare function taskMemorySource(messages: readonly unknown[]): string;
export declare function taskMemoryPrompt(previous: string, chunk: string): string;
export declare function updateTaskMemory(
  messages: readonly unknown[],
  settings: MemoryModelSettings,
  run: (modelId: string, prompt: string) => Promise<string>,
  previous?: TaskMemoryResult | null,
  onFailure?: (modelId: string, error: unknown) => void,
): Promise<TaskMemoryResult | null>;
