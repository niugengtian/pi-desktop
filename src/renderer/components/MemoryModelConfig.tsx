import { useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import type { MemoryModelSettings } from "@shared/memory-model";
import { useI18n } from "@/i18n";

export function MemoryModelConfig() {
  const { t } = useI18n();
  const [ollamaAutoStart, setOllamaAutoStart] = useState(false);
  const [settings, setSettings] = useState<MemoryModelSettings | null>(null);
  const [version, setVersion] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void Promise.all([
      call("memoryModel.get"),
      call("modelsConfig.get"),
      window.piBridge?.getUiState() ?? Promise.resolve({ ollamaAutoStart: false }),
    ])
      .then(([snapshot, modelConfig, ui]) => {
        if (!live) return;
        setSettings(snapshot.settings);
        setVersion(snapshot.version);
        setOllamaAutoStart(ui.ollamaAutoStart === true);
        const providers = modelConfig.config.providers;
        if (!providers || typeof providers !== "object") return;
        const choices: string[] = [];
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

  async function toggleOllama(next: boolean) {
    if (!window.piBridge) return;
    setBusy(true);
    setMessage("");
    setOllamaAutoStart(next);
    try {
      await window.piBridge.setUiState({ ollamaAutoStart: next });
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
        {t(
          "memoryDeliveryDescription",
          "Memory processing is independent of the chat model. Completed effective-branch turns produce local hot/warm Markdown. Model switches and budget pressure require an exact approval; Web always requires approval.",
        )}
      </p>
      <label style={{ display: "block", marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={ollamaAutoStart}
          disabled={busy || !window.piBridge || window.piBridge.platform === "win32"}
          onChange={(event) => void toggleOllama(event.target.checked)}
        />{" "}
        {t("ollamaAutoStart", "Start local Ollama with the App (off by default)")}
      </label>
      <p>
        {t(
          "ollamaAutoStartDescription",
          "Reuse a running local Ollama, or start an existing installation on 127.0.0.1:11434. No model download. App exit stops only the app-owned process; external Ollama stays running. Use Check health to verify availability.",
        )}
      </p>
      {window.piBridge?.platform === "win32" && (
        <p>
          {t(
            "ollamaAutoStartUnsupported",
            "On Windows, start Ollama externally; app-owned auto-start currently supports macOS/Linux.",
          )}
        </p>
      )}
      <label style={{ display: "block", marginBottom: 20 }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
        />{" "}
        Enable independent memory (on by default)
      </label>
      <p>
        {t(
          "memoryFailureDescription",
          "Only explicitly configured loopback models process memory. A primary failure tries your configured backup and reports locally. Cancellation, stale memory or failure never falls back to sending raw history. Normal same-model API/tool continuation stays unchanged when within budget.",
        )}
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
            <button type="button" disabled={!model} onClick={() => void check(model)}>
              Check health
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
        {t(
          "memoryCommandsDescription",
          "Use /task-memory-preview, /task-memory-refresh and /task-memory-search (or cold QUERY) locally. Sending an approved summary to an external provider is still external traffic. QMD is optional and deferred.",
        )}
      </p>
    </section>
  );
}
