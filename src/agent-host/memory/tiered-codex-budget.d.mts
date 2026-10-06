import type { BudgetPolicy, BudgetReport } from "./tiered-budget.mjs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
export function checkCodexDispatch(
  url: string | URL | Request,
  body: unknown,
  model: NonNullable<AgentSession["model"]>,
  expectedPayload: string | undefined,
): void;
export function nativeBudgetView<T>(messages: T[]): {
  messages: T[];
  opaque: Map<string, number>;
  opaqueReserved: number;
};
export function planCodexBudget(
  payload: Record<string, unknown>,
  model: NonNullable<AgentSession["model"]>,
  options?: {
    nativeMessages?: unknown[];
    warmText?: string;
    operation?: "chat" | "native-compaction";
    policy?: BudgetPolicy;
    outputReservation?: number;
  },
): BudgetReport;
