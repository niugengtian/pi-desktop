import { useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import { inputStyle } from "./form-controls";

export function WarmModelConfig() {
  const [model, setModel] = useState("");
  const [version, setVersion] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string; warning?: string }>>([]);
  const [savedModel, setSavedModel] = useState("");
  const selected = models.find((item) => item.id === model);
  const buttonStyle = {
    minHeight: 34,
    padding: "6px 12px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
  };
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      const result = await call("warmModel.get");
      setModel(result.model);
      setSavedModel(result.model);
      setVersion(result.version);
      setModels(result.models);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    setBusy(true);
    try {
      const result = await call("warmModel.set", { model, expectedVersion: version });
      setVersion(result.version);
      setSavedModel(result.model);
      setMessage("默认 Warm 模型已保存。重新加载或新建会话后生效；不会立即发送历史。");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section style={{ marginBottom: 24, paddingBottom: 20, borderBottom: "1px solid var(--border)" }}>
      <h2 style={{ marginTop: 0 }}>Warm 摘要模型</h2>
      <p>
        独立于聊天模型与下方任务记忆。只列出已配置且受支持的 API、Codex 账号和本机 Ollama
        模型。摘要发送仍须审批，失败不自动更换模型或账号。
      </p>
      <label htmlFor="warm-model">摘要作业者</label>
      <select
        id="warm-model"
        style={{ ...inputStyle, margin: "8px 0", width: "100%", fontFamily: "inherit" }}
        value={model}
        disabled={busy}
        onChange={(event) => {
          setModel(event.target.value);
          setMessage("");
        }}
      >
        {!models.some((item) => item.id === model) && <option value={model}>{model || "加载中…"}（当前不可用）</option>}
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.id}
          </option>
        ))}
      </select>
      {selected?.warning && (
        <p role="alert" style={{ margin: "4px 0 12px", color: "var(--text-muted)", fontSize: 12 }}>
          {selected.warning}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          disabled={busy || !selected || model === savedModel}
          onClick={() => void save()}
          style={{
            ...buttonStyle,
            background: "var(--accent)",
            borderColor: "var(--accent)",
            color: "white",
            opacity: busy || !selected || model === savedModel ? 0.5 : 1,
          }}
        >
          保存默认
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => void load()}
        >
          刷新模型
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
