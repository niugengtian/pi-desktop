import type { ReadonlySessionManager } from "@earendil-works/pi-coding-agent";
type SdkMessage = ReturnType<ReadonlySessionManager["buildSessionProjection"]>["messages"][number];

export interface BudgetPolicy {
  hotTarget: number;
  hotMax: number;
  warmTarget: number;
  warmMax: number;
  safety: number;
}
export const TIERED_BUDGET: Readonly<BudgetPolicy>;
export interface EnvelopeEstimate {
  method: string;
  accuracy: string;
  wireBytes: number;
  estimatedTokens: number;
  assumptions: string;
}
export interface BudgetReport {
  action: "block" | "allow";
  reasons: string[];
  operation: string;
  model: string;
  window: number;
  outputReserved: number;
  safetyReserved: number;
  inputAllowance: number;
  hotTarget: number;
  hotAllowance: number;
  warmTarget: number;
  warmAllowance: number;
  protocolEstimate: EnvelopeEstimate;
  warmEstimate: EnvelopeEstimate;
  hotEstimate: EnvelopeEstimate;
  totalEstimate: EnvelopeEstimate;
}
export function estimateEnvelope(value: unknown, messages?: number, tools?: number): EnvelopeEstimate;
export function wireText(message: { content?: unknown }): string;
export function planWireBudget(
  payload: unknown,
  model: { id: string; provider: string; api: string; contextWindow: number; maxTokens: number },
  options?: { warmText?: string; operation?: string; policy?: BudgetPolicy },
): BudgetReport;
export const enforceWireBudget: typeof planWireBudget;
export function nativeBudgetHints(
  messages: SdkMessage[],
  model: { contextWindow: number; maxTokens: number },
  sdkEstimate: (message: SdkMessage) => number,
  policy?: BudgetPolicy,
): {
  needsNativeCompaction: boolean;
  keepRecentTokens: number;
  reserveTokens: number;
  hotTarget: number;
  hotEstimate: number;
};
