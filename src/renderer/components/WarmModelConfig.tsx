import { useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import { inputStyle } from "./form-controls";

export function WarmModelConfig() {
  const [model, setModel] = useState("");
  const [version, setVersion] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      const result = await call("warmModel.get");
      setModel(result.model);
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
        style={{ ...inputStyle, margin: "8px 0", width: "100%" }}
        value={model}
        disabled={busy}
        onChange={(event) => setModel(event.target.value)}
      >
        {!models.some((item) => item.id === model) && <option value={model}>{model || "加载中…"}（当前不可用）</option>}
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.id}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !models.some((item) => item.id === model)}
        onClick={() => void save()}
        style={{
          background: "var(--accent)",
          color: "white",
          border: 0,
          borderRadius: 5,
          padding: "8px 12px",
          cursor: "pointer",
        }}
      >
        保存为默认 Warm 模型
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => void load()}>
        刷新可用模型
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
