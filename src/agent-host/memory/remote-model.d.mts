import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
export declare const FLASH_MEMORY_MODEL: "deepseek/deepseek-flash";
export declare const MAX_REMOTE_SOURCE_CHARS: 12000;
export declare function remoteSourcePreview(candidates: { role: string; text: string }[]): string;
export declare function createFlashMemoryRunner(options: {
  runtime: ModelRuntime;
  signal?: AbortSignal;
  authorized: () => boolean;
  transport?: typeof fetch;
  onEvent?: (event: { phase: string; at: string; status?: number }) => void;
}): (id: string, prompt: string) => Promise<string>;
