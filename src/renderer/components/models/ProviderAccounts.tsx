import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { inputStyle } from "../form-controls";
import { call } from "@/lib/api-client";
import type { Api } from "@contract/api";

type Account = Api["accounts.list"]["result"]["accounts"][number];

const secondaryButton: CSSProperties = {
  padding: "6px 10px",
  minHeight: 32,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
};

const primaryButton: CSSProperties = {
  ...secondaryButton,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
};

/** Login/key entry stays in the application's existing official auth UI. */
export function ProviderAccounts({
  onRefresh,
  onSelect,
}: {
  onRefresh: () => void;
  onSelect: (provider: string, kind: Account["kind"]) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [kind, setKind] = useState<Account["kind"]>("codex");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setAccounts((await call("accounts.list")).accounts);
    } catch {
      setError("无法读取账号配置");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setName("");
      setEditing(null);
      await load();
      onRefresh();
    } catch {
      setError("操作失败：检查名称，或等待此账号的请求结束后重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      style={{
        padding: "10px 18px",
        borderBottom: "1px solid var(--border)",
        maxHeight: "50%",
        overflowY: "auto",
        flexShrink: 0,
      }}
      onToggle={() => void load()}
    >
      <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: "28px" }}>
        多账号管理 <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>· Codex / Anthropic API</span>
      </summary>
      <div style={{ padding: "10px 0 4px", display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          Codex 使用网页授权；Anthropic API 使用 API Key（非 Claude Code
          CLI）。点击账号可在下方登录；会话通过模型选择器切换账号。
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts.map((account) => (
            <div
              key={account.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "var(--bg-panel)",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => onSelect(account.provider, account.kind)}
                title="打开账号登录与模型设置"
                style={{
                  border: "none",
                  background: "none",
                  padding: 0,
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  textAlign: "left",
                }}
              >
                {account.kind === "codex" ? "Codex" : "Anthropic API"} · {account.name}
              </button>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, minWidth: 100 }}>
                {account.loggedIn ? "已保存登录" : "未登录"}
                {account.isDefault ? " · 默认" : ""}
              </span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={secondaryButton}
                  disabled={busy}
                  onClick={() => {
                    setEditing(account.id);
                    setName(account.name);
                  }}
                >
                  重命名
                </button>
                {!account.isDefault && (
                  <button
                    type="button"
                    style={secondaryButton}
                    disabled={busy}
                    onClick={() => void mutate(() => call("accounts.update", { id: account.id, action: "default" }))}
                  >
                    设默认
                  </button>
                )}
                <button
                  type="button"
                  style={secondaryButton}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("移除此账号？保留历史和绑定，不会自动切换账号。"))
                      void mutate(() => call("accounts.update", { id: account.id, action: "remove" }));
                  }}
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        </div>
        <form
          style={{ display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap" }}
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(() =>
              editing
                ? call("accounts.update", { id: editing, action: "rename", name })
                : call("accounts.add", { kind, name }),
            );
          }}
        >
          {!editing && (
            <label
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}
            >
              账号类型
              <select
                aria-label="账号类型"
                value={kind}
                disabled={busy}
                onChange={(event) => setKind(event.target.value as Account["kind"])}
                style={{ ...inputStyle, width: "auto", minWidth: 140, fontFamily: "inherit" }}
              >
                <option value="codex">Codex 订阅</option>
                <option value="anthropic-api">Anthropic API Key</option>
              </select>
            </label>
          )}
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: "var(--text-muted)",
              flex: "1 1 180px",
            }}
          >
            {editing ? "重命名账号" : "账号名称"}
            <input
              aria-label="账号名称"
              placeholder="例如：公司账号（不填凭证）"
              maxLength={80}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              style={{ ...inputStyle, fontFamily: "inherit" }}
            />
          </label>
          <button
            type="submit"
            style={{ ...primaryButton, minHeight: 36, opacity: busy || !name.trim() ? 0.5 : 1 }}
            disabled={busy || !name.trim()}
          >
            {editing ? "保存名称" : "新增账号"}
          </button>
          {editing && (
            <button
              type="button"
              style={{ ...secondaryButton, minHeight: 36 }}
              onClick={() => {
                setEditing(null);
                setName("");
              }}
            >
              取消
            </button>
          )}
        </form>
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--error, #c33)" }}>
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
