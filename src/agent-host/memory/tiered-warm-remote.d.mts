import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { WarmPlan } from "./tiered-warm.mjs";
export const WARM_TARGET: string;
export interface WarmReply {
  answer: string;
  usage?: Usage;
}
export type WarmRunnerFactory = (options: {
  signal: AbortSignal;
  authorized: () => boolean;
}) => (plan: WarmPlan) => Promise<WarmReply>;
export function createFlashWarmRunner(options: {
  runtime: ModelRuntime;
  signal?: AbortSignal;
  authorized: () => boolean;
  transport?: typeof fetch;
}): (plan: WarmPlan) => Promise<WarmReply>;
