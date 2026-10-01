import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearImmediate, setImmediate } from "node:timers";
import { buildTieredSnapshot, TieredWorkspace } from "./tiered-workspace.mjs";

/** Stage 1 only: opt-in local mirrors. NO context/compaction/provider transformations. */
export function createTieredWorkspaceExtension() {
  return {
    name: "pi-desktop-tiered-workspace-compare",
    hidden: true,
    factory(pi: ExtensionAPI) {
      let active:
        | {
            manager: ExtensionContext["sessionManager"];
            sessionId: string;
            workspace: TieredWorkspace;
          }
        | undefined;
      let timer: ReturnType<typeof setImmediate> | undefined;
      let epoch = 0;
      const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info") => {
        try {
          ctx.ui.notify(text, type);
        } catch {
          /* Replaced UI is not a chat error. */
        }
      };
      const cancelTimer = () => {
        if (timer) clearImmediate(timer);
        timer = undefined;
        epoch++;
      };
      const disable = () => {
        cancelTimer();
        active = undefined;
      };
      const refresh = (ctx: ExtensionContext, target?: { label: string; provider: string; modelId: string }) => {
        const state = active;
        if (!state || state.manager !== ctx.sessionManager || state.sessionId !== ctx.sessionManager.getSessionId())
          return;
        const generation = epoch;
        try {
          const snapshot = buildTieredSnapshot(ctx.sessionManager);
          const result = state.workspace.sync(snapshot, {
            assertCurrent: () =>
              active === state &&
              epoch === generation &&
              state.manager === ctx.sessionManager &&
              state.sessionId === ctx.sessionManager.getSessionId() &&
              snapshot.identity.leafId === ctx.sessionManager.getLeafId(),
            target,
          });
          notify(
            ctx,
            `Local tiered view v${result.revision}: ${result.root}\nNative context unchanged; no remote request or confirmed relay.`,
          );
        } catch (error) {
          disable(); // Human conflict/partial write must not silently keep updating.
          notify(
            ctx,
            `Local tiered export paused; existing evidence retained. ${error instanceof Error ? error.message : "Export failed"}`,
            "warning",
          );
        }
      };
      pi.registerCommand("tiered-workspace-enable", {
        description: "Compare: explicitly enable local cold/warm/hot views; native context unchanged",
        handler: async (_args, ctx) => {
          if (active) {
            notify(ctx, "Local tiered views are already enabled for this session.");
            return;
          }
          if (!ctx.hasUI || !ctx.isIdle()) {
            notify(ctx, "Enable requires an idle session and explicit UI approval.", "warning");
            return;
          }
          const manager = ctx.sessionManager;
          const sessionId = manager.getSessionId();
          const leafId = manager.getLeafId();
          const generation = epoch;
          const accepted = await ctx.ui.confirm(
            "Enable local tiered comparison?",
            [
              `Directory: ${manager.getCwd()}/pi_agent_desktop_session-${sessionId}`,
              "Exports the full existing native JSONL, including inactive branches/tools, to this working directory.",
              "Not automatically redacted; local history may contain sensitive text. Permissions 0700/0600; generated .gitignore excludes files.",
              "Warm mirrors ONLY native SDK compaction, not the existing Flash vault. Hot is the complete SDK projection.",
              "No automatic remote upload, no extra model request, no context/compaction budget change.",
              "Session replacement, navigation or restart disables updates. Files remain local.",
            ].join("\n"),
          );
          if (
            !accepted ||
            epoch !== generation ||
            manager !== ctx.sessionManager ||
            sessionId !== manager.getSessionId() ||
            leafId !== manager.getLeafId() ||
            !ctx.isIdle()
          )
            return;
          try {
            // Validate flushed authority BEFORE creating any workspace.
            buildTieredSnapshot(manager);
            active = { manager, sessionId, workspace: new TieredWorkspace(manager.getCwd(), sessionId) };
            refresh(ctx);
          } catch (error) {
            disable();
            notify(
              ctx,
              `Local comparison not enabled: ${error instanceof Error ? error.message : "Validation failed"}`,
              "warning",
            );
          }
        },
      });
      pi.registerCommand("tiered-workspace-disable", {
        description: "Stop local tiered exports without deleting evidence",
        handler: async (_args, ctx) => {
          disable();
          notify(ctx, "Local tiered updates disabled; files and native history retained.");
        },
      });
      pi.registerCommand("tiered-workspace-refresh", {
        description: "Refresh approved local views; does not call a model",
        handler: async (_args, ctx) => {
          if (!active) {
            notify(ctx, "Disabled; use /tiered-workspace-enable for local-source approval.");
            return;
          }
          if (!ctx.isIdle()) {
            notify(ctx, "Wait for the current run to settle.", "warning");
            return;
          }
          cancelTimer();
          refresh(ctx);
        },
      });
      pi.on("before_agent_start", () => {
        cancelTimer();
      });
      pi.on("agent_settled", (_event, ctx) => {
        cancelTimer();
        if (!active) return;
        timer = setImmediate(() => {
          timer = undefined;
          refresh(ctx);
        });
      });
      pi.on("session_compact", (_event, ctx) => {
        cancelTimer();
        refresh(ctx);
      });
      pi.on("model_select", (event, ctx) => {
        cancelTimer();
        if (!active || event.source === "restore") return;
        const label = `${event.model.provider}_${event.model.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
        refresh(ctx, { label, provider: event.model.provider, modelId: event.model.id });
      });
      pi.on("session_start", disable);
      pi.on("session_before_switch", disable);
      pi.on("session_before_fork", disable);
      pi.on("session_before_tree", disable);
      pi.on("session_shutdown", disable);
    },
  };
}
