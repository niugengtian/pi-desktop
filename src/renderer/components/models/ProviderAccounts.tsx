import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import type { Api } from "@contract/api";

type Account = Api["accounts.list"]["result"]["accounts"][number];

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
      style={{ padding: "8px 18px", borderBottom: "1px solid var(--border)", maxHeight: "45%", overflowY: "auto" }}
      onToggle={() => {
        void load();
      }}
    >
      <summary>多账号管理 · Codex / Anthropic API</summary>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Codex 使用订阅登录；Anthropic API 使用 API Key，不等同于 Claude Code
        CLI。选择账号后在下方登录／重新登录。切换模型时，模型名称中的账号即请求归属。
      </p>
      {accounts.map((account) => (
        <div
          key={account.id}
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}
        >
          <button disabled={busy} onClick={() => onSelect(account.provider, account.kind)}>
            {account.kind === "codex" ? "Codex" : "Anthropic API"} · {account.name}
          </button>
          <span>
            {account.loggedIn ? "已保存登录（请求时验证）" : "未登录"}
            {account.isDefault ? " · 默认" : ""}
          </span>
          <button
            disabled={busy}
            onClick={() => {
              setEditing(account.id);
              setName(account.name);
            }}
          >
            命名
          </button>
          <button
            disabled={busy || account.isDefault}
            onClick={() => void mutate(() => call("accounts.update", { id: account.id, action: "default" }))}
          >
            设默认
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (window.confirm("移除此账号？保留历史和绑定，不会自动切换账号。"))
                void mutate(() => call("accounts.update", { id: account.id, action: "remove" }));
            }}
          >
            移除
          </button>
        </div>
      ))}
      <form
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
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
          <select
            aria-label="账号类型"
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value as Account["kind"])}
          >
            <option value="codex">Codex 订阅</option>
            <option value="anthropic-api">Anthropic API Key</option>
          </select>
        )}
        <input
          aria-label="账号名称"
          placeholder="账号名称（不要输入凭证）"
          maxLength={80}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <button disabled={busy || !name.trim()}>{editing ? "保存名称" : "新增账号"}</button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setName("");
            }}
          >
            取消
          </button>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
