import { ManagedProcessService } from "../service.ts";

/** Entirely fictional containment; never supplies fake identity to a real worker. */
export function managedBashFixture({ onCommit, unregister, enabled = true, serviceOptions = {} } = {}) {
  const backends = [],
    calls = [];
  const context = {
    inventoryRevision: 17,
    resolutionId: "fictional-pinned-resolution",
    nativeEnv: {},
    shellEnv: { PATH: "/fixture/bin:/usr/bin" },
    summary: [],
    commands: {
      "shell.bash": {
        capability: "shell.bash",
        provider: "system",
        executable: "/fixture/bash",
        argvPrefix: [],
        cwdSemantics: "native",
        envPatch: {},
      },
    },
  };
  const service = new ManagedProcessService(
    { emit() {} },
    {
      platform: "darwin",
      runtime: {
        async createExecutionContext() {
          throw new Error("Native Bash must not resolve a second environment");
        },
        requireFromContext(_capability, resolved) {
          return resolved.commands["shell.bash"];
        },
      },
      parentCall: async (method, params) => {
        calls.push({ method, params });
        if (method === "managedProcesses.getSettings") return { enabled, reaperReady: true };
        if (method === "managedProcesses.register") return { journalRevision: 1 };
        if (method === "managedProcesses.unregister") {
          await unregister?.();
          return { journalRevision: 2, removed: true };
        }
        throw new Error(`Unexpected fixture call ${method}`);
      },
      posixBackendFactory: () => {
        let listener, finish;
        const ended = new Promise((resolve) => {
          finish = resolve;
        });
        const backend = {
          child: {},
          writes: [],
          committed: false,
          stopped: false,
          onEvent(value) {
            listener = value;
            return () => {
              listener = undefined;
            };
          },
          emit(event) {
            listener?.(event);
          },
          end(exit = { code: 0, reason: "exit" }) {
            if (backend.ended) return;
            backend.ended = true;
            backend.emit({ type: "exit", exit });
            finish();
          },
          async prepare(input) {
            backend.input = input;
            return {
              reaper: {
                version: 2,
                platform: "posix",
                processId: input.processId,
                runId: input.runId,
                hostInstanceId: "fictional-host",
                pid: 50000,
                pgid: 50000,
                startFingerprint: "fictional",
                nonce: "fictional",
                createdAt: Date.now(),
              },
              privateState: null,
            };
          },
          async commit() {
            backend.committed = true;
            setImmediate(() => onCommit?.(backend));
            return { started: true };
          },
          write(input) {
            backend.writes.push(input);
          },
          async stop() {
            backend.stopped = true;
            backend.end({ code: null, reason: "stopped" });
          },
          async dispose() {
            await backend.stop();
          },
          waitForExit() {
            return ended;
          },
        };
        backends.push(backend);
        return backend;
      },
      ...serviceOptions,
    },
  );
  return { service, context, backends, calls };
}
