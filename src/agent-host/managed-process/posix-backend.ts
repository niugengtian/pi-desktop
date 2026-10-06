import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ToolExecutionContext } from "../../shared/toolchains/types.ts";
import {
  getProcessStartFingerprint,
  terminatePosixProcessGroup,
  terminateProcessTree,
} from "../../shared/node/process-tree.ts";
import type {
  ManagedProcessBackend,
  ManagedProcessBackendEvent,
  PreparedContainment,
  PreparedManagedProcessLaunch,
  StartedContainment,
} from "./backend.ts";
import type {
  ManagedProcessWorkerBootstrap,
  ManagedProcessWorkerEvent,
  ManagedProcessWorkerRequest,
} from "./protocol.ts";

const WORKER_START_TIMEOUT_MS = 10_000;

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  void promise.catch(() => undefined); // Either phase can fail before its caller begins awaiting it.
  return { promise, resolve, reject };
}

function cleanEnvironment(context: ToolExecutionContext, processId: string, runId: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(context.shellEnv)) {
    if (typeof value === "string") environment[key] = value;
  }
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PI_DESKTOP_MANAGED_PROCESS = "1";
  environment.PI_DESKTOP_MANAGED_PROCESS_ID = processId;
  environment.PI_DESKTOP_MANAGED_RUN_ID = runId;
  return environment;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface PosixManagedProcessBackendOptions {
  platform: "darwin" | "linux";
  workerEntryPath: string;
  workerExecArgv?: readonly string[];
  hostInstanceId: string;
  spawnProcess?: typeof spawn;
  fingerprint?: typeof getProcessStartFingerprint;
  terminateProcessGroup?: typeof terminatePosixProcessGroup;
  now?: () => number;
}

export class PosixManagedProcessBackend implements ManagedProcessBackend {
  private readonly options: Required<
    Pick<PosixManagedProcessBackendOptions, "platform" | "workerEntryPath" | "hostInstanceId">
  > &
    Omit<PosixManagedProcessBackendOptions, "platform" | "workerEntryPath" | "hostInstanceId">;
  private readonly events = new EventEmitter();
  private readonly ready = deferred();
  private readonly started = deferred();
  private readonly exited = deferred();
  private process?: ChildProcess;
  private prepared?: PreparedContainment;
  private targetExit?: { code: number | null; signal?: string };
  private bootstrap?: ManagedProcessWorkerBootstrap;
  private commitSent = false;
  private committed = false;
  private stopRequested = false;
  private exitReported = false;

  constructor(options: PosixManagedProcessBackendOptions) {
    this.options = options;
  }

  get child(): ChildProcess | undefined {
    return this.process;
  }

  onEvent(listener: (event: ManagedProcessBackendEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async prepare(input: PreparedManagedProcessLaunch, signal?: AbortSignal): Promise<PreparedContainment> {
    if (this.process) throw new Error("POSIX managed process backend was already prepared");
    if (signal?.aborted) throw new Error("Managed process start was cancelled");
    const spawnProcess = this.options.spawnProcess ?? spawn;
    let worker: ChildProcess;
    try {
      worker = spawnProcess(process.execPath, [...(this.options.workerExecArgv ?? []), this.options.workerEntryPath], {
        cwd: input.cwd,
        env: cleanEnvironment(input.context, input.processId, input.runId),
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      throw new Error("Could not start the managed process worker", { cause: error });
    }
    this.process = worker;
    worker.stdout?.on("data", (chunk: Buffer | string) =>
      this.events.emit("event", {
        type: "stdout",
        bytes: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      } satisfies ManagedProcessBackendEvent),
    );
    worker.stderr?.on("data", (chunk: Buffer | string) =>
      this.events.emit("event", {
        type: "stderr",
        bytes: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      } satisfies ManagedProcessBackendEvent),
    );
    worker.on("message", (message: ManagedProcessWorkerEvent) => this.handleWorkerEvent(message));
    worker.once("error", (error) => {
      this.ready.reject(new Error("Managed process worker failed to prepare"));
      this.started.reject(new Error("Managed process worker failed to start"));
      this.events.emit("event", {
        type: "error",
        subcode: "WORKER_START_FAILED",
        message: error.message,
      } satisfies ManagedProcessBackendEvent);
    });
    worker.once("close", (code, closeSignal) => void this.handleWorkerClose(code, closeSignal));

    const bootstrap: ManagedProcessWorkerBootstrap = {
      type: "bootstrap",
      protocol: 2,
      nonce: randomUUID(),
      processId: input.processId,
      runId: input.runId,
      cwd: input.cwd,
      command: input.command,
      shell: input.shell,
    };
    this.bootstrap = bootstrap;
    const onAbort = () => {
      void this.stop("force", "host").catch(() => undefined); // Preparation still verifies/disposes its worker.
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let fingerprint: string | null;
    try {
      worker.send(bootstrap);
      await withTimeout(this.ready.promise, WORKER_START_TIMEOUT_MS, "Managed process worker did not prepare");
      if (signal?.aborted || this.stopRequested) throw new Error("Managed process start was cancelled");
      if (!worker.pid) throw new Error("Managed process worker has no PID");
      fingerprint = await (this.options.fingerprint ?? getProcessStartFingerprint)(worker.pid);
      if (!fingerprint) throw new Error("Could not verify managed process identity");
      if (
        signal?.aborted ||
        this.stopRequested ||
        !worker.connected ||
        worker.exitCode !== null ||
        worker.signalCode !== null
      )
        throw new Error("Managed process preparation lost its live owner");
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    const prepared: PreparedContainment = {
      reaper: {
        version: 2,
        platform: "posix",
        processId: input.processId,
        runId: input.runId,
        hostInstanceId: this.options.hostInstanceId,
        pid: worker.pid!,
        pgid: worker.pid!,
        startFingerprint: fingerprint,
        nonce: bootstrap.nonce,
        createdAt: (this.options.now ?? Date.now)(),
      },
      privateState: { pid: worker.pid },
    };
    this.prepared = prepared;
    return prepared;
  }

  async commit(prepared: PreparedContainment, journalRevision: number): Promise<StartedContainment> {
    if (
      prepared !== this.prepared ||
      prepared.reaper.platform !== "posix" ||
      !Number.isSafeInteger(journalRevision) ||
      journalRevision <= 0 ||
      this.commitSent ||
      this.stopRequested ||
      !this.process?.connected ||
      this.process.exitCode !== null ||
      this.process.signalCode !== null
    ) {
      throw new Error("Invalid POSIX prepared containment");
    }
    this.commitSent = true;
    this.process!.send({
      type: "commit",
      processId: prepared.reaper.processId,
      runId: prepared.reaper.runId,
      nonce: prepared.reaper.nonce,
      journalRevision,
    } satisfies ManagedProcessWorkerRequest);
    await withTimeout(this.started.promise, WORKER_START_TIMEOUT_MS, "Managed shell did not start after commit");
    this.committed = true;
    return { started: true };
  }

  write(input: { text: string; appendNewline: boolean; close: boolean }): void {
    const worker = this.process;
    if (!this.committed || !worker?.connected)
      throw new Error("Managed process is not committed or its control pipe is closed");
    worker.send({ type: "stdin", ...input } satisfies ManagedProcessWorkerRequest);
  }

  async stop(mode: "graceful" | "force", source: "agent" | "user" | "host" | "main"): Promise<void> {
    const worker = this.process;
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    this.stopRequested = true;
    if (worker.connected) worker.send({ type: "stop", mode, source } satisfies ManagedProcessWorkerRequest);
  }

  waitForExit(): Promise<void> {
    return this.exited.promise;
  }

  async dispose(): Promise<void> {
    const worker = this.process;
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    try {
      await this.stop("force", "host");
      await withTimeout(this.exited.promise, 1_000, "Worker stop was not acknowledged");
      return;
    } catch {
      /* Retain the existing process-group fallback if IPC did not settle. */
    }
    await terminateProcessTree(worker, 1_000);
    await Promise.race([
      this.exited.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        timer.unref();
      }),
    ]);
  }

  private handleWorkerEvent(message: ManagedProcessWorkerEvent): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "prepared") {
      if (
        !this.bootstrap ||
        this.commitSent ||
        message.processId !== this.bootstrap.processId ||
        message.runId !== this.bootstrap.runId ||
        message.nonce !== this.bootstrap.nonce
      ) {
        this.ready.reject(new Error("Managed worker preparation identity mismatch"));
      } else this.ready.resolve();
      return;
    }
    if (message.type === "started") {
      if (!this.commitSent || !Number.isSafeInteger(message.shellPid) || message.shellPid <= 1) {
        this.ready.reject(new Error("Managed shell started without a matching commit"));
        this.started.reject(new Error("Managed shell PID is invalid"));
      } else {
        this.started.resolve();
      }
      return;
    }
    if (message.type === "stdin-closed") {
      this.events.emit("event", { type: "stdin-closed" } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (message.type === "stopping") {
      this.events.emit("event", { type: "stopping", phase: message.phase } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (message.type === "error") {
      this.events.emit("event", {
        type: "error",
        subcode: message.code,
        message: message.message,
      } satisfies ManagedProcessBackendEvent);
      this.ready.reject(new Error("Managed process worker reported an error"));
      this.started.reject(new Error("Managed process worker reported an error"));
      return;
    }
    if (message.type === "exit")
      this.targetExit = { code: message.code, ...(message.signal ? { signal: message.signal } : {}) };
  }

  private async handleWorkerClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.ready.reject(new Error("Managed process worker exited during preparation"));
    this.started.reject(new Error("Managed process worker exited during startup"));
    const worker = this.process;
    const processGroupId = this.prepared?.reaper.platform === "posix" ? this.prepared.reaper.pgid : worker?.pid;
    let treeClean = true;
    if (processGroupId) {
      try {
        treeClean = await (this.options.terminateProcessGroup ?? terminatePosixProcessGroup)(processGroupId, {
          interruptMs: 250,
          terminateMs: 750,
          forceMs: 1_000,
        });
      } catch {
        treeClean = false;
      }
    }
    if (!this.exitReported) {
      this.exitReported = true;
      const target = this.targetExit ?? { code, ...(signal ? { signal } : {}) };
      this.events.emit("event", {
        type: "exit",
        exit: {
          ...target,
          reason: treeClean ? (this.stopRequested ? "stopped" : "exit") : "host-failure",
        },
      } satisfies ManagedProcessBackendEvent);
    }
    this.exited.resolve();
  }
}
