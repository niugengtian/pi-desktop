import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAccounts } from "../provider-accounts";
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
  target?: string;
}) => (plan: WarmPlan) => Promise<WarmReply>;
export function supportsWarmModel(model: unknown, runtime?: ModelRuntime): boolean;
export function listWarmModels(runtime: ModelRuntime): Promise<string[]>;
export function createFlashWarmRunner(options: {
  runtime: ModelRuntime;
  accountStore?: ProviderAccounts;
  signal?: AbortSignal;
  authorized: () => boolean;
  target?: string;
  transport?: typeof fetch;
  onEvent?: (event: Record<string, string | number | undefined>) => void;
}): (plan: WarmPlan) => Promise<WarmReply>;
