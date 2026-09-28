import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, subscribe } from "@/lib/api-client";

export function SharedTerminalDock({ sessionId, cwd, onHide }: { sessionId: string; cwd: string; onHide: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const isDark = document.documentElement.classList.contains("dark");
    const terminalBackground = isDark ? "#25211c" : "#d8d0bc";
    const terminalForeground = isDark ? "#ded8ca" : "#40383d";
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"SF Mono", Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Arial Unicode MS", monospace',
      fontSize: 14,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: {
        background: terminalBackground,
        foreground: terminalForeground,
        cursor: isDark ? "#e8b07a" : "#40383d",
        selectionBackground: isDark ? "#655747" : "#aca58e",
        black: "#201b21",
        red: "#be100e",
        green: "#858162",
        yellow: "#eaa549",
        blue: "#426a78",
        magenta: "#97522c",
        cyan: "#527c8d",
        white: "#a8a49b",
        brightBlack: "#665e61",
        brightRed: "#d5150d",
        brightGreen: "#989770",
        brightYellow: "#ffb454",
        brightBlue: "#547d8b",
        brightMagenta: "#a85e35",
        brightCyan: "#6a91a0",
        brightWhite: "#d8d0bc",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitRef.current = fit;
    fit.fit();

    let disposed = false;
    const disposables = [
      terminal.onData((data) => void call("sharedTerminal.write", { sessionId, data }).catch(showError)),
      terminal.onResize(
        ({ cols, rows }) => void call("sharedTerminal.resize", { sessionId, cols, rows }).catch(() => undefined),
      ),
    ];
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The panel may be between layout states.
      }
    });
    observer.observe(mount);
    const unsubscribe: Array<() => void> = [];
    const showError = (value: unknown) => {
      if (!disposed) setError(value instanceof Error ? value.message : String(value));
    };
    void Promise.all([
      subscribe("sharedTerminal.output", sessionId, (event) => terminal.write(event.data)),
      subscribe("sharedTerminal.exit", sessionId, () => terminal.write("\r\n[终端连接已断开]\r\n")),
    ])
      .then((items) => {
        if (disposed) items.forEach((item) => item());
        else unsubscribe.push(...items);
        return call("sharedTerminal.attach", { sessionId, cwd, cols: terminal.cols, rows: terminal.rows });
      })
      .then(() => terminal.focus())
      .catch(showError);

    return () => {
      disposed = true;
      unsubscribe.forEach((item) => item());
      observer.disconnect();
      disposables.forEach((item) => item.dispose());
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      void call("sharedTerminal.detach", { sessionId }).catch(() => undefined);
    };
  }, [cwd, sessionId]);

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "light-dark(#d8d0bc, #25211c)",
      }}
    >
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 8px 0 12px",
          borderBottom: "1px solid color-mix(in srgb, var(--border) 75%, var(--text-muted))",
          color: "light-dark(#40383d, #ded8ca)",
          fontSize: 12,
        }}
      >
        <span style={{ flex: 1 }}>共享终端 · {cwd}</span>
        {error && (
          <span title={error} style={{ color: "#fca5a5", marginRight: 10 }}>
            连接失败
          </span>
        )}
        <button
          type="button"
          onClick={onHide}
          title="隐藏终端"
          aria-label="隐藏终端"
          style={{
            width: 26,
            height: 24,
            border: 0,
            borderRadius: 5,
            background: "transparent",
            color: "light-dark(#40383d, #ded8ca)",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>
      <div ref={mountRef} aria-label="共享终端" style={{ flex: 1, minHeight: 0, padding: "6px 8px" }} />
    </div>
  );
}
