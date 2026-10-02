import type { Model, Api } from "@earendil-works/pi-ai";
import type { TieredSnapshot } from "./tiered-workspace.mjs";
import type { BudgetPolicy } from "./tiered-budget.mjs";
export const WEB_CONTRACT: "pi-tiered-web-1";
export function isTieredWebModel(model: Model<Api>): boolean;
export interface WebPayload {
  schema: string;
  sessionId: string;
  sourceHash: string;
  projectionHash: string;
  modelId: string;
  site: string;
  mode: string;
  text: string;
  promptHash: string;
  warmVersion: string | null;
  hotSourceEntryIds: string[];
  newConversation: true;
  dedupe: false;
  attachments: [];
}
export interface WebPlan {
  payload: WebPayload;
  hotSourceEntryIds: string[];
  warmVersion: string | null;
  omittedThinking: number;
  report: {
    action: string;
    reasons: string[];
    algorithm: string;
    estimatedTokens: number;
    wireBytes: number;
    warmEstimated: number;
    hotEstimated: number;
    outputReserved: number;
    outputCapEnforced: false;
    websiteWindowMeasured: false;
  };
}
export function buildTieredWebPlan(snapshot: TieredSnapshot, model: Model<Api>, policy?: BudgetPolicy): WebPlan;
export function checkWebDispatch(request: unknown, payload: WebPayload): string;
export function checkWebReceipt(receipt: unknown, payload: WebPayload, dispatchId: string, markdown: string): unknown;
