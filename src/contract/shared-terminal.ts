export interface SharedTerminalProbeResult {
  supported: boolean;
  tmuxPath?: string;
  version?: string;
  reason?: "platform-unsupported" | "tmux-not-found" | "probe-failed";
}

export interface SharedTerminalSessionInfo {
  sessionId: string;
  name: string;
  cwd: string;
  exists: boolean;
}
