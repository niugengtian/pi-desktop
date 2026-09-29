import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
export declare function isLoopbackModel(model: { baseUrl?: string } | null | undefined): boolean;
export declare function createLocalMemoryRunner(options?: {
  signal?: AbortSignal;
  runtime?: ModelRuntime;
}): Promise<(modelId: string, prompt: string) => Promise<string>>;
