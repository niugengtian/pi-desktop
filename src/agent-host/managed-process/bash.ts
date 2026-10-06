import { constants } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { isManagedProcessActiveState, type ManagedProcessPublicInfo } from "../../contract/processes.ts";
import type { ToolExecutionContext } from "../../shared/toolchains/types.ts";
import { sanitizeToolEnvironment } from "../tool-environment.ts";
import type { ManagedProcessService } from "./service.ts";
import type { ProcessAdmissionWait } from "./admission.ts";

export type ManagedBashOptions = Parameters<BashOperations["exec"]>[2] & {
  onAdmission?: (wait: ProcessAdmissionWait | null) => void;
};

/** Runs native Bash with the same owner, recovery journal and settlement as process tools. */
export function createManagedBashOperations(
  service: ManagedProcessService,
  ownerSessionId: string,
  ownerCwd: string,
  trusted: boolean,
  context: ToolExecutionContext,
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const seconds = options.timeout;
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1_000 > 2_147_483_647))
        throw new Error("Invalid Bash timeout");
      if (options.signal?.aborted) throw new Error("aborted");
      const controller = new AbortController();
      let processInfo: ManagedProcessPublicInfo | undefined;
      let timedOut = false;
      let acceptingOutput = true;
      let outputError: Error | undefined;
      const abort = () => controller.abort();
      const stop = () => {
        if (processInfo)
          void service
            .stop(processInfo.processId, processInfo.runId, "force", "agent", ownerSessionId)
            .catch(() => undefined);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", stop, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const started = await service.startForAgent(
          ownerSessionId,
          ownerCwd,
          trusted,
          {
            command,
            cwd,
            kind: "task",
            label: "Task Bash",
            waitFor: { type: "none" },
          },
          controller.signal,
          {
            context: { ...context, shellEnv: sanitizeToolEnvironment(options.env ?? context.shellEnv) },
            onAdmission: (options as ManagedBashOptions).onAdmission,
            onCommitted() {
              if (seconds !== undefined && !controller.signal.aborted)
                timer = setTimeout(() => {
                  timedOut = true;
                  controller.abort();
                }, seconds * 1_000);
            },
            onEvent(event) {
              if (!acceptingOutput) return;
              try {
                if (event.type === "stdout" || event.type === "stderr") options.onData(event.bytes);
                if (event.type === "output-dropped") throw new Error("Native Bash output was dropped by containment");
                if (event.type === "error") throw new Error(`Native Bash containment error: ${event.subcode}`);
              } catch (error) {
                outputError ??= error instanceof Error ? error : new Error(String(error));
                controller.abort();
              }
            },
          },
        );
        processInfo = started.process;
        if (controller.signal.aborted) stop();
        let cursor = started.output.nextCursor;
        while (isManagedProcessActiveState(service.get(processInfo.processId, ownerSessionId).state)) {
          const observation = await service.wait(
            { processId: processInfo.processId, runId: processInfo.runId, cursor, timeoutMs: 30_000 },
            ownerSessionId,
            false,
            controller.signal,
          );
          cursor = observation.nextCursor;
        }
        // Terminal state alone is insufficient: this also waits for reaper acknowledgement.
        const settled = await service.settleOwned(processInfo.processId, processInfo.runId, ownerSessionId);
        if (outputError) throw outputError;
        if (options.signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${seconds}`);
        if (settled.exit?.reason === "stopped") throw new Error("Native Bash was stopped");
        const signal = settled.exit?.signal as NodeJS.Signals | undefined;
        return { exitCode: settled.exit?.code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : null) };
      } catch (error) {
        if (processInfo) await service.settleOwned(processInfo.processId, processInfo.runId, ownerSessionId);
        if (outputError) throw outputError;
        if (options.signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${seconds}`);
        throw error;
      } finally {
        acceptingOutput = false;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", stop);
      }
    },
  };
}
