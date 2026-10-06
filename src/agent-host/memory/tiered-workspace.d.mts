import type { ReadonlySessionManager } from "@earendil-works/pi-coding-agent";

export interface TieredSnapshot {
  identity: { sessionId: string; leafId: string | null; branchHash: string; sourcePath: string; sourceHash: string };
  boundCwd: string;
  warm: {
    version: string | null;
    summary: string;
    sourceEntryIds: string[];
    factsStatus: "not-extracted" | "human-reviewed-extractive-not-lossless";
    processor: "flash-off-incremental" | "sdk-native";
    factVersion: number | null;
  };
  hot: Array<{ sourceEntryId: string; message: unknown }>;
  projectedContext: unknown[];
  pendingToolCallIds: string[];
  handoff: string;
  files: Record<string, string | Buffer>;
}
export function tieredHash(value: string | Buffer): string;
export function pendingNativeSource(manager: ReadonlySessionManager): Buffer | undefined;
export function buildTieredSnapshot(manager: ReadonlySessionManager): TieredSnapshot;
export class TieredWorkspace {
  constructor(boundCwd: string, sessionId: string);
  readonly root: string;
  readonly sessionId: string;
  readonly boundCwd: string;
  verify(): boolean;
  sync(
    snapshot: TieredSnapshot,
    options?: {
      assertCurrent?: () => boolean;
      target?: { label: string; provider: string; modelId: string };
    },
  ): { root: string; revision: number; relay?: string; sourceHash: string };
}
