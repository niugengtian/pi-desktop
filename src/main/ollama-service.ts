import { spawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ManagedProcessReaper } from "./managed-process/reaper";
import type { ManagedProcessReaperRecord } from "../contract/processes";
import { getProcessStartFingerprint, terminatePosixProcessGroup } from "../shared/node/process-tree";

type EndpointState = "ready" | "unavailable" | "occupied";
type ServiceState = "disabled" | "external" | "starting" | "owned" | "failed";
type Child = Pick<ChildProcess, "pid" | "once" | "kill" | "exitCode" | "signalCode">;
interface Options {
  reaper: Pick<ManagedProcessReaper, "status" | "register" | "reapAll">;
  platform?: NodeJS.Platform;
  probe?: () => Promise<EndpointState>;
  findBinary?: () => Promise<string | null>;
  spawn?: (binary: string, env: NodeJS.ProcessEnv) => Child;
  fingerprint?: typeof getProcessStartFingerprint;
  terminate?: typeof terminatePosixProcessGroup;
  startupMs?: number;
  log?: (message: string) => void;
}

/** Direct IPv4 HTTP: no proxy, redirect, auth or remote discovery. */
export function probeOllama(): Promise<EndpointState> {
  return new Promise((resolve) => {
    let finished = false;
    const done = (state: EndpointState) => {
      if (!finished) {
        finished = true;
        resolve(state);
      }
    };
    const req = request({ hostname: "127.0.0.1", port: 11434, path: "/api/version", method: "GET" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (part: string) => {
        text += part;
        if (text.length > 2048) {
          done("occupied");
          req.destroy();
        }
      });
      res.once("error", () => done("occupied"));
      res.once("end", () => {
        try {
          done(
            res.statusCode === 200 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(JSON.parse(text).version)
              ? "ready"
              : "occupied",
          );
        } catch {
          done("occupied");
        }
      });
    });
    req.setTimeout(1000, () => {
      done("occupied");
      req.destroy();
    });
    req.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED" ? "unavailable" : "occupied"),
    );
    req.end();
  });
}

async function findOllama(): Promise<string | null> {
  const paths =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"]
      : ["/usr/local/bin/ollama", "/usr/bin/ollama", join(homedir(), ".local", "bin", "ollama")];
  for (const file of paths) {
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {
      /* An optional system installation may be absent. */
    }
  }
  return null;
}

/** Opt-in App-owned service; never installs/pulls a model or signals a reused server. */
export class OllamaService {
  private state: ServiceState = "disabled";
  private generation = 0;
  private abort: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  private child: Child | null = null;
  private record: ManagedProcessReaperRecord | null = null;
  private stopping = false;
  private readonly owner = `main-ollama-${randomUUID()}`;
  constructor(private readonly options: Options) {}
  getState(): ServiceState {
    return this.state;
  }

  configure(enabled: boolean): Promise<void> {
    const generation = ++this.generation;
    this.abort?.abort();
    const action = this.queue
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation) return;
        if (!enabled) {
          await this.stopOwned();
          this.state = "disabled";
          return;
        }
        const abort = new AbortController();
        this.abort = abort;
        try {
          await this.start(generation, abort.signal);
        } catch (error) {
          await this.stopOwned();
          if (generation !== this.generation) return;
          this.state = "failed";
          this.options.log?.("Ollama local startup failed; no model was downloaded");
          throw error;
        }
      });
    this.queue = action;
    return action;
  }
  stop(): Promise<void> {
    return this.configure(false);
  }

  private async start(generation: number, signal: AbortSignal): Promise<void> {
    const probe = this.options.probe ?? probeOllama;
    const endpoint = await probe();
    signal.throwIfAborted();
    if (endpoint === "ready") {
      this.state = this.child ? "owned" : "external";
      return;
    }
    if (endpoint === "occupied")
      throw new Error("Port 11434 is occupied or Ollama did not respond; no process was replaced.");
    if ((this.options.platform ?? process.platform) === "win32")
      throw new Error("Ollama auto-start is supported on macOS/Linux; start Ollama externally on Windows.");
    if (!this.options.reaper.status().ready)
      throw new Error("Ollama auto-start requires a ready process cleanup journal.");
    if (this.record) await this.stopOwned();
    const binary = await (this.options.findBinary ?? findOllama)();
    signal.throwIfAborted();
    if (!binary) throw new Error("Ollama is not installed in a supported location. No download was started.");
    this.state = "starting";
    const env = { ...process.env, OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_NO_CLOUD: "1" };
    const child = (
      this.options.spawn ??
      ((file, environment) =>
        spawn(file, ["serve"], {
          env: environment,
          shell: false,
          detached: true,
          stdio: "ignore",
        }))
    )(binary, env);
    this.child = child;
    // Keep errors observable without unhandled EventEmitter errors. Do not log
    // daemon stdout/stderr, which may include unrelated users' requests.
    let spawnError: Error | null = null;
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("exit", () => {
      if (this.child === child && !this.stopping) {
        this.state = "failed";
        this.options.log?.("App-owned Ollama exited; automatic model download/retry is disabled");
      }
    });
    try {
      if (!child.pid || child.pid <= 1) throw new Error("Ollama could not be started.");
      const fingerprint = await (this.options.fingerprint ?? getProcessStartFingerprint)(child.pid);
      if (!fingerprint) throw new Error("Ollama process ownership could not be verified.");
      const record: ManagedProcessReaperRecord = {
        version: 2,
        platform: "posix",
        processId: `ollama-${randomUUID()}`,
        runId: randomUUID(),
        hostInstanceId: this.owner,
        nonce: randomUUID(),
        createdAt: Date.now(),
        pid: child.pid,
        pgid: child.pid,
        startFingerprint: fingerprint,
      };
      this.options.reaper.register(record);
      this.record = record;
      const deadline = Date.now() + (this.options.startupMs ?? 20_000);
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (spawnError || child.exitCode !== null || child.signalCode !== null)
          throw new Error("The app-owned Ollama process exited before readiness.");
        if ((await probe()) === "ready") {
          signal.throwIfAborted();
          if (generation !== this.generation) return;
          this.state = "owned";
          this.options.log?.("Ollama ready on 127.0.0.1:11434 (app-owned, cloud disabled)");
          return;
        }
        await sleep(100, undefined, { signal });
      }
      throw new Error("Local Ollama startup timed out; no model was downloaded.");
    } catch (error) {
      if (!this.record && child.pid) {
        // Registration can fail before the journal takes ownership. Only this
        // just-spawned process group is eligible for emergency cleanup.
        if (child.exitCode === null && child.signalCode === null)
          await (this.options.terminate ?? terminatePosixProcessGroup)(child.pid, {
            interruptMs: 100,
            terminateMs: 1000,
            forceMs: 1000,
          });
        this.child = null;
      }
      throw error;
    }
  }
  private async stopOwned(): Promise<void> {
    if (!this.record) {
      this.child = null;
      return;
    }
    this.stopping = true;
    let report;
    try {
      report = await this.options.reaper.reapAll(this.owner);
    } finally {
      this.stopping = false;
    }
    if (!report.ready)
      throw new Error("App-owned Ollama cleanup could not be confirmed; see the process cleanup journal.");
    this.child = null;
    this.record = null;
  }
}
