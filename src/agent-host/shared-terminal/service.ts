import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SharedTerminalProbeResult, SharedTerminalSessionInfo } from "../../contract/shared-terminal";

const execFileAsync = promisify(execFile);
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

function safeSessionName(sessionId: string): string {
  const normalized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  if (!normalized) throw new Error("有效的 PI 会话 ID 是必需的");
  return `pi-${normalized}`;
}

export class SharedTerminalService {
  private probeCache: SharedTerminalProbeResult | null = null;
  private readonly ownedSessions = new Map<string, SharedTerminalSessionInfo>();

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
    const probe = await this.probe();
    if (!probe.supported || !probe.tmuxPath) throw new Error("未检测到可用的 tmux");
    if (!path.isAbsolute(cwd)) throw new Error("终端工作目录必须是绝对路径");
    const name = safeSessionName(sessionId);
    const existing = await this.hasSession(probe.tmuxPath, name);
    if (!existing) {
      await execFileAsync(probe.tmuxPath, ["new-session", "-d", "-s", name, "-c", cwd], {
        timeout: 10_000,
        windowsHide: true,
      });
    }
    const info = { sessionId, name, cwd, exists: true };
    this.ownedSessions.set(sessionId, info);
    return info;
  }

  async status(sessionId: string): Promise<SharedTerminalSessionInfo | null> {
    const info = this.ownedSessions.get(sessionId);
    if (!info) return null;
    const probe = await this.probe();
    if (!probe.supported || !probe.tmuxPath) return { ...info, exists: false };
    return { ...info, exists: await this.hasSession(probe.tmuxPath, info.name) };
  }

  async close(sessionId: string): Promise<{ ok: true }> {
    const info = this.ownedSessions.get(sessionId);
    this.ownedSessions.delete(sessionId);
    if (!info) return { ok: true };
    const probe = await this.probe();
    if (probe.supported && probe.tmuxPath && (await this.hasSession(probe.tmuxPath, info.name))) {
      await execFileAsync(probe.tmuxPath, ["kill-session", "-t", info.name], { timeout: 5_000, windowsHide: true });
    }
    return { ok: true };
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.ownedSessions.keys()].map((sessionId) => this.close(sessionId)));
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
