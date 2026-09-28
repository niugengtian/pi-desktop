import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { IPty } from "node-pty";
import type { RpcServer } from "../../contract/rpc";
import type {
  SharedTerminalExitEvent,
  SharedTerminalOutputEvent,
  SharedTerminalProbeResult,
  SharedTerminalSessionInfo,
} from "../../contract/shared-terminal";

const execFileAsync = promisify(execFile);
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

type TerminalRecord = SharedTerminalSessionInfo & { generation: number; pty?: IPty };

function safeSessionName(sessionId: string): string {
  const normalized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  if (!normalized) throw new Error("有效的 PI 会话 ID 是必需的");
  return `pi-${normalized}`;
}

export class SharedTerminalService {
  private probeCache: SharedTerminalProbeResult | null = null;
  private readonly records = new Map<string, TerminalRecord>();
  private readonly server?: Pick<RpcServer, "emit">;

  constructor(server?: Pick<RpcServer, "emit">) {
    this.server = server;
  }

  async probe(refresh = false): Promise<SharedTerminalProbeResult> {
    if (!refresh && this.probeCache) return this.probeCache;
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return (this.probeCache = { supported: false, reason: "platform-unsupported" });
    }
    const tmuxPath = await this.resolveTmuxPath();
    if (!tmuxPath) return (this.probeCache = { supported: false, reason: "tmux-not-found" });
    try {
      const { stdout } = await execFileAsync(tmuxPath, ["-V"], { timeout: 5_000, windowsHide: true });
      const version = stdout.trim().slice(0, 120);
      return (this.probeCache = { supported: true, tmuxPath, ...(version ? { version } : {}) });
    } catch {
      return (this.probeCache = { supported: false, tmuxPath, reason: "probe-failed" });
    }
  }

  async ensure(sessionId: string, cwd: string): Promise<SharedTerminalSessionInfo> {
    const probe = await this.requireTmux();
    if (!path.isAbsolute(cwd)) throw new Error("终端工作目录必须是绝对路径");
    const name = safeSessionName(sessionId);
    if (!(await this.hasSession(probe.tmuxPath, name))) {
      await execFileAsync(probe.tmuxPath, ["new-session", "-d", "-s", name, "-c", cwd], {
        timeout: 10_000,
        windowsHide: true,
      });
    }
    const previous = this.records.get(sessionId);
    const record: TerminalRecord = previous ?? { sessionId, name, cwd, exists: true, attached: false, generation: 0 };
    record.cwd = cwd;
    record.exists = true;
    this.records.set(sessionId, record);
    return this.publicInfo(record);
  }

  async attach(sessionId: string, cwd: string, cols: number, rows: number): Promise<SharedTerminalSessionInfo> {
    await this.ensure(sessionId, cwd);
    const probe = await this.requireTmux();
    const record = this.records.get(sessionId)!;
    this.detachRecord(record);
    const nodePty = await import("node-pty");
    record.generation += 1;
    const generation = record.generation;
    const pty = nodePty.spawn(probe.tmuxPath, ["attach-session", "-t", record.name], {
      name: "xterm-256color",
      cols: this.dimension(cols, 80),
      rows: this.dimension(rows, 24),
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    record.pty = pty;
    record.attached = true;
    pty.onData((data) => {
      if (record.pty !== pty) return;
      const event: SharedTerminalOutputEvent = { sessionId, generation, data };
      this.server?.emit("sharedTerminal.output", sessionId, event);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (record.pty !== pty) return;
      record.pty = undefined;
      record.attached = false;
      const event: SharedTerminalExitEvent = { sessionId, generation, exitCode, ...(signal ? { signal } : {}) };
      this.server?.emit("sharedTerminal.exit", sessionId, event);
    });
    return this.publicInfo(record);
  }

  write(sessionId: string, data: string): { ok: true } {
    const pty = this.records.get(sessionId)?.pty;
    if (!pty) throw new Error("共享终端尚未连接");
    pty.write(data.slice(0, 65_536));
    return { ok: true };
  }

  resize(sessionId: string, cols: number, rows: number): { ok: true } {
    const pty = this.records.get(sessionId)?.pty;
    if (!pty) throw new Error("共享终端尚未连接");
    pty.resize(this.dimension(cols, 80), this.dimension(rows, 24));
    return { ok: true };
  }

  detach(sessionId: string): { ok: true } {
    const record = this.records.get(sessionId);
    if (record) this.detachRecord(record);
    return { ok: true };
  }

  async capture(sessionId: string, lines = 200): Promise<{ text: string }> {
    const probe = await this.requireTmux();
    const record = this.records.get(sessionId);
    if (!record) throw new Error("共享终端不存在");
    const boundedLines = Math.max(1, Math.min(2_000, Math.trunc(lines)));
    const { stdout } = await execFileAsync(
      probe.tmuxPath,
      ["capture-pane", "-p", "-J", "-S", `-${boundedLines}`, "-t", record.name],
      { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    return { text: stdout.slice(-1024 * 1024) };
  }

  async send(sessionId: string, text: string, enter = true): Promise<{ ok: true }> {
    const probe = await this.requireTmux();
    const record = this.records.get(sessionId);
    if (!record) throw new Error("共享终端不存在");
    const bounded = text.slice(0, 65_536);
    await execFileAsync(probe.tmuxPath, ["set-buffer", "-b", "pi-agent-input", "--", bounded], {
      timeout: 5_000,
      windowsHide: true,
    });
    await execFileAsync(probe.tmuxPath, ["paste-buffer", "-b", "pi-agent-input", "-t", record.name, "-d"], {
      timeout: 5_000,
      windowsHide: true,
    });
    if (enter) await execFileAsync(probe.tmuxPath, ["send-keys", "-t", record.name, "Enter"], { timeout: 5_000 });
    return { ok: true };
  }

  async status(sessionId: string): Promise<SharedTerminalSessionInfo | null> {
    const record = this.records.get(sessionId);
    if (!record) return null;
    const probe = await this.probe();
    if (!probe.supported || !probe.tmuxPath) return { ...this.publicInfo(record), exists: false };
    record.exists = await this.hasSession(probe.tmuxPath, record.name);
    return this.publicInfo(record);
  }

  async close(sessionId: string): Promise<{ ok: true }> {
    const record = this.records.get(sessionId);
    this.records.delete(sessionId);
    if (!record) return { ok: true };
    this.detachRecord(record);
    const probe = await this.probe();
    if (probe.supported && probe.tmuxPath && (await this.hasSession(probe.tmuxPath, record.name))) {
      await execFileAsync(probe.tmuxPath, ["kill-session", "-t", record.name], { timeout: 5_000, windowsHide: true });
    }
    return { ok: true };
  }

  async shutdown(): Promise<void> {
    for (const record of this.records.values()) this.detachRecord(record);
    this.records.clear();
  }

  private publicInfo(record: TerminalRecord): SharedTerminalSessionInfo {
    return {
      sessionId: record.sessionId,
      name: record.name,
      cwd: record.cwd,
      exists: record.exists,
      attached: record.attached,
    };
  }

  private detachRecord(record: TerminalRecord): void {
    const pty = record.pty;
    record.pty = undefined;
    record.attached = false;
    if (pty) pty.kill();
  }

  private dimension(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(2, Math.min(500, Math.trunc(value))) : fallback;
  }

  private async requireTmux(): Promise<{ supported: true; tmuxPath: string }> {
    const probe = await this.probe();
    if (!probe.supported || !probe.tmuxPath) throw new Error("未检测到可用的 tmux");
    return { supported: true, tmuxPath: probe.tmuxPath };
  }

  private async resolveTmuxPath(): Promise<string | null> {
    for (const candidate of TMUX_CANDIDATES) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next fixed executable path. PATH is intentionally not executed through a shell.
      }
    }
    return null;
  }

  private async hasSession(tmuxPath: string, name: string): Promise<boolean> {
    try {
      await execFileAsync(tmuxPath, ["has-session", "-t", name], { timeout: 5_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
}
