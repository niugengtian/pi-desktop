import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, subscribe } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";

export function SharedTerminalDock({ sessionId, cwd, onHide }: { sessionId: string; cwd: string; onHide: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"SF Mono", Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Arial Unicode MS", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: "#f7f6f3",
        foreground: "#1c1a17",
        cursor: "#1c1a17",
        selectionBackground: "#ded9cf",
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
        brightWhite: "#eee9dc",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitRef.current = fit;
    fit.fit();

    let disposed = false;
    const copySelection = () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      void window.piBridge
        .writeClipboardText(selection)
        .catch(() => copyText(selection))
        .catch(showError);
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (!terminal.hasSelection()) return;
      event.preventDefault();
      copySelection();
    };
    const handleCopy = (event: ClipboardEvent) => {
      const selection = terminal.getSelection();
      if (!selection || !event.clipboardData) return;
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData.setData("text/plain", selection);
    };
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      void call("sharedTerminal.write", { sessionId, data: text }).catch(showError);
    };
    mount.addEventListener("contextmenu", handleContextMenu);
    mount.addEventListener("copy", handleCopy, true);
    mount.addEventListener("paste", handlePaste, true);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        copySelection();
      }
      if (key === "v") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void navigator.clipboard
          ?.readText()
          .then((text) => (text ? call("sharedTerminal.write", { sessionId, data: text }) : undefined))
          .catch(showError);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) return false;
      if (key === "v") return false;
      return true;
    });
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
      window.removeEventListener("keydown", handleKeyDown, true);
      mount.removeEventListener("contextmenu", handleContextMenu);
      mount.removeEventListener("copy", handleCopy, true);
      mount.removeEventListener("paste", handlePaste, true);
      disposables.forEach((item) => item.dispose());
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      void call("sharedTerminal.detach", { sessionId }).catch(() => undefined);
    };
  }, [cwd, sessionId]);

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 8px 0 12px",
          borderBottom: "1px solid var(--border)",
          color: "var(--text)",
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
            color: "var(--text)",
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
