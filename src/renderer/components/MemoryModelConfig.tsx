import { useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import type { MemoryModelSettings } from "@shared/memory-model";

export function MemoryModelConfig() {
  const [settings, setSettings] = useState<MemoryModelSettings | null>(null);
  const [version, setVersion] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void Promise.all([call("memoryModel.get"), call("modelsConfig.get")])
      .then(([snapshot, modelConfig]) => {
        if (!live) return;
        setSettings(snapshot.settings);
        setVersion(snapshot.version);
        const providers = modelConfig.config.providers;
        if (!providers || typeof providers !== "object") return;
        const choices: string[] = ["deepseek/deepseek-flash"];
        for (const [provider, raw] of Object.entries(providers)) {
          if (!raw || typeof raw !== "object") continue;
          const entry = raw as { baseUrl?: string; models?: Array<{ id?: string }> };
          let local = false;
          try {
            local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(entry.baseUrl ?? "").hostname);
          } catch {
            /* only explicit local providers */
          }
          if (local && Array.isArray(entry.models)) {
            for (const model of entry.models) if (model.id) choices.push(`${provider}/${model.id}`);
          }
        }
        setModels(choices);
      })
      .catch((error) => {
        if (live) setMessage(String(error));
      });
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await call("memoryModel.set", { settings, expectedVersion: version });
      setSettings(result.settings);
      setVersion(result.version);
      setMessage("Memory settings saved. Reload the active Pi session to use an updated plugin.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function check(model: string) {
    if (!model) return;
    setProbe((current) => ({ ...current, [model]: "Checking…" }));
    try {
      const result = await call("memoryModel.probe", { model });
      setProbe((current) => ({
        ...current,
        [model]: result.ok ? `Available (${result.latencyMs} ms)` : `Unavailable: ${result.error}`,
      }));
    } catch (error) {
      setProbe((current) => ({ ...current, [model]: `Unavailable: ${String(error)}` }));
    }
  }

  if (!settings) return <section style={{ padding: 24 }}>Loading memory settings… {message}</section>;
  return (
    <section style={{ padding: 24, overflowY: "auto", width: "100%", maxWidth: 760, lineHeight: 1.6 }}>
      <h2 style={{ marginTop: 0 }}>Independent task memory</h2>
      <p>
        Task memory runs in the background after completed chat turns, independently of the active chat model. Summaries
        are saved for review, never implicitly inserted into main-chat provider context.
      </p>
      <label style={{ display: "block", marginBottom: 20 }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
        />{" "}
        Enable independent memory (on by default)
      </label>
      <p>
        Local mode accepts registered loopback models. Remote mode accepts only deepseek/deepseek-flash at
        api.deepseek.com with thinking disabled and no backup. Saving settings does NOT authorize sending history: run
        /task-memory-enable-remote in the session to review and approve current and future text. Permission is
        session-only, revocable, and not persisted across restarts. No Web provider is used.
      </p>
      <datalist id="memory-local-models">
        {models.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      {(["primary", "fallback"] as const).map((key) => {
        const model = settings[key] ?? "";
        return (
          <div key={key} style={{ margin: "16px 0" }}>
            <label htmlFor={`memory-${key}`} style={{ display: "block" }}>
              {key === "primary" ? "Primary model" : "Backup model (optional)"}
            </label>
            <input
              id={`memory-${key}`}
              list="memory-local-models"
              value={model}
              onChange={(event) =>
                setSettings({ ...settings, [key]: event.target.value || (key === "fallback" ? null : "") })
              }
              placeholder="provider/model-id"
              style={{ width: "min(100%, 430px)" }}
            />{" "}
            <button
              type="button"
              disabled={!model || model === "deepseek/deepseek-flash"}
              onClick={() => void check(model)}
            >
              {model === "deepseek/deepseek-flash" ? "Approve sources in session" : "Check health"}
            </button>
            {probe[model] && <div role="status">{probe[model]}</div>}
          </div>
        );
      })}
      <button type="button" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save memory settings"}
      </button>
      {message && <p role="status">{message}</p>}
      <p>
        Run <code>/task-memory-preview</code> to inspect the last summary and <code>/task-memory-disable-remote</code>
        to revoke remote permission. Remote input is NOT automatically redacted; do not include secrets. Tool,
        compaction and branch-summary sources are blocked in remote mode pending a separate data policy. Local mode
        remains the default.
      </p>
    </section>
  );
}
