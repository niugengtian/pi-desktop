import type { CompactionPreparation, SessionManager } from "@earendil-works/pi-coding-agent";
export function alignWarmToolBoundary(
  manager: Pick<SessionManager, "buildSessionProjection">,
  preparation: CompactionPreparation,
): CompactionPreparation;
