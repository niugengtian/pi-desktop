import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MemoryModelSettings } from "../../shared/memory-model";
import type { TaskMemoryResult } from "./task-memory.mjs";
export interface CompiledTaskMemory {
  path: string;
  hash: string;
  unchanged: boolean;
  record: { id: string; tier: "hot" | "warm"; title: string; summary: string };
  memory: TaskMemoryResult;
  hotChars: number;
  warmCount: number;
}
export declare function compileTaskMemory(options: {
  entries: SessionEntry[];
  branchLeafId: string;
  sessionId: string;
  settings: MemoryModelSettings;
  run: (modelId: string, prompt: string) => Promise<string>;
  root: string;
  previous?: TaskMemoryResult | null;
  expectedHash?: string | null;
  onFailure?: (modelId: string, error: unknown) => void;
  hotChars?: number;
}): Promise<CompiledTaskMemory | null>;
