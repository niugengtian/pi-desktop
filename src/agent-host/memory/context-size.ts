import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { nativeBudgetView } from "./tiered-codex-budget.mjs";
import { estimateEnvelope, TIERED_BUDGET } from "./tiered-budget.mjs";
type Messages = ReturnType<SessionManager["buildSessionProjection"]>["messages"];

/** Routing estimates, never billing counts or an alternate context slicer. */
export function contextSizePlan(messages: Messages, model: { contextWindow: number; maxTokens: number }) {
  const view = nativeBudgetView(messages);
  const protocol = view.messages.filter((message) => message.role === "system");
  const history = view.messages.filter((message) => message.role !== "system");
  const available = Math.max(
    1,
    model.contextWindow -
      model.maxTokens -
      TIERED_BUDGET.safety -
      estimateEnvelope(protocol, protocol.length).estimatedTokens,
  );
  const small = Math.max(1, Math.min(4000, Math.floor(available * 0.1)));
  const large = Math.max(small, Math.min(16000, Math.floor(available * 0.35)));
  const estimatedTokens = history.reduce((sum, message) => sum + estimateTokens(message), 0) + view.opaqueReserved;
  const envelope = estimateEnvelope(history, history.length).estimatedTokens + view.opaqueReserved;
  const mode =
    estimatedTokens > large || envelope > available * 0.85
      ? "warm"
      : estimatedTokens > small
        ? "hot-handoff"
        : "native";
  return {
    mode,
    estimatedTokens,
    small,
    large,
    available,
    envelope,
    measurement: "SDK estimate plus reported opaque reservation; not exact tokens",
  };
}
