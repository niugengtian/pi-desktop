import { spawn, type ChildProcess } from "node:child_process";
import type {
  ManagedProcessWorkerBootstrap,
  ManagedProcessWorkerEvent,
  ManagedProcessWorkerRequest,
} from "./protocol.ts";

let child: ChildProcess | null = null;
let bootstrapped = false;
let prepared: ManagedProcessWorkerBootstrap | undefined;
let commitTimer: NodeJS.Timeout | undefined;
let stopping = false;
let exiting = false;

function send(event: ManagedProcessWorkerEvent): void {
  if (!process.connected) return;
  try {
    process.send?.(event);
  } catch {
    /* parent disappeared */
  }
}

function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code ? `Managed shell error (${code})` : "Managed shell error";
}

function groupSignal(signal: NodeJS.Signals): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      send({ type: "error", code: "SIGNAL_FAILED", message: "Could not signal managed process group" });
  }
}

function waitForChild(timeoutMs: number): Promise<boolean> {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      current.removeListener("close", onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    current.once("close", onClose);
  });
}

function forceStop(): void {
  send({ type: "stopping", phase: "force" });
  groupSignal("SIGKILL");
  setTimeout(() => process.exit(1), 1_500).unref();
}

async function stop(mode: "graceful" | "force"): Promise<void> {
  if (mode === "force" && child) {
    forceStop();
    return;
  }
  if (stopping || exiting) return;
  stopping = true;
  if (!child) {
    process.exit(0);
    return;
  }
  if (mode !== "force") {
    send({ type: "stopping", phase: "interrupt" });
    groupSignal("SIGINT");
    if (await waitForChild(2_000)) return;
    send({ type: "stopping", phase: "terminate" });
    groupSignal("SIGTERM");
    if (await waitForChild(3_000)) return;
  }
  forceStop();
}

function validBootstrap(value: ManagedProcessWorkerBootstrap): boolean {
  return Boolean(
    value &&
    value.type === "bootstrap" &&
    value.protocol === 2 &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    value.nonce.length <= 200 &&
    typeof value.processId === "string" &&
    typeof value.runId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.command === "string" &&
    value.shell &&
    typeof value.shell.executable === "string" &&
    Array.isArray(value.shell.argvPrefix) &&
    value.shell.argvPrefix.every((argument) => typeof argument === "string"),
  );
}

function start(input: ManagedProcessWorkerBootstrap): void {
  if (bootstrapped || !validBootstrap(input)) {
    send({ type: "error", code: "INVALID_BOOTSTRAP", message: "Invalid managed process bootstrap" });
    if (child) forceStop();
    else process.exit(2);
    return;
  }
  bootstrapped = true;
  prepared = input;
  send({ type: "prepared", processId: input.processId, runId: input.runId, nonce: input.nonce });
  commitTimer = setTimeout(() => {
    send({ type: "error", code: "COMMIT_TIMEOUT", message: "Managed process commit timed out" });
    process.exit(2);
  }, 30_000);
  commitTimer.unref();
}

function commit(message: Extract<ManagedProcessWorkerRequest, { type: "commit" }>): void {
  const input = prepared;
  if (
    !input ||
    child ||
    stopping ||
    exiting ||
    !process.connected ||
    message.processId !== input.processId ||
    message.runId !== input.runId ||
    message.nonce !== input.nonce ||
    !Number.isSafeInteger(message.journalRevision) ||
    message.journalRevision <= 0
  ) {
    send({ type: "error", code: "INVALID_COMMIT", message: "Invalid managed process commit" });
    if (child) forceStop();
    else process.exit(2);
    return;
  }
  if (commitTimer) clearTimeout(commitTimer);
  prepared = undefined;
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  try {
    child = spawn(input.shell.executable, [...input.shell.argvPrefix, "-c", input.command], {
      cwd: input.cwd,
      env: childEnvironment,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    send({ type: "error", code: "SPAWN_FAILED", message: safeError(error) });
    process.exit(2);
    return;
  }

  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.once("spawn", () => send({ type: "started", shellPid: child?.pid ?? 0 }));
  child.once("error", (error) => {
    send({ type: "error", code: "SPAWN_FAILED", message: safeError(error) });
    if (!child?.pid) process.exit(2);
  });
  child.once("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    send({ type: "exit", code, ...(signal ? { signal } : {}) });
    // Descendants can keep the root's stdio open after its exit, so waiting for
    // "close" can deadlock cleanup. Keep this worker alive as the group identity
    // until escalation, even if the Host/control pipe disappears meanwhile.
    if (!stopping) groupSignal("SIGTERM");
    setTimeout(forceStop, 250);
  });
}

process.on("message", (value: unknown) => {
  const message = value as ManagedProcessWorkerRequest;
  if (message?.type === "bootstrap") {
    start(message);
    return;
  }
  if (message?.type === "commit") {
    commit(message);
    return;
  }
  if (message?.type === "stop") {
    void stop(message.mode);
    return;
  }
  if (!bootstrapped || !child) return;
  if (message?.type === "stdin") {
    if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      send({ type: "stdin-closed" });
      return;
    }
    if (message.text) child.stdin.write(message.appendNewline ? `${message.text}\n` : message.text);
    else if (message.appendNewline) child.stdin.write("\n");
    if (message.close) {
      child.stdin.end();
      send({ type: "stdin-closed" });
    }
    return;
  }
});

process.on("disconnect", () => {
  void stop("graceful");
});
process.on("SIGINT", () => {
  if (!stopping) void stop("graceful");
});
process.on("SIGTERM", () => {
  if (!stopping) void stop("graceful");
});

setTimeout(() => {
  if (bootstrapped) return;
  send({ type: "error", code: "BOOTSTRAP_TIMEOUT", message: "Managed process bootstrap timed out" });
  process.exit(2);
}, 10_000).unref();
