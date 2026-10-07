import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type AuthInteraction,
  type Credential,
  type Provider,
} from "@earendil-works/pi-ai";

function accountStream(
  createSource: () => AssistantMessageEventStream,
  provider: string,
  model: { id: string; api: import("@earendil-works/pi-ai").Api },
  acquire: () => () => void,
) {
  const output = createAssistantMessageEventStream();
  let release = () => {};
  void (async () => {
    release = acquire();
    const source = createSource();
    for await (const event of source) {
      const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
      message.provider = provider;
      if (event.type === "error") {
        const detail = message.errorMessage ?? "";
        message.errorMessage = /quota|usage.limit|insufficient|credit|429|rate.limit/i.test(detail)
          ? "This account reached a quota or rate limit. Wait or select another account explicitly; no account fallback was used."
          : /401|403|expired|unauthor|token|auth/i.test(detail)
            ? "This account's login is invalid or expired. Re-login this account; no account fallback was used."
            : "This account's request failed or was cancelled. No account fallback was used.";
      }
      output.push(event);
    }
    output.end(await source.result());
  })()
    .catch(() => {
      output.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          model: model.id,
          provider,
          timestamp: Date.now(),
          stopReason: "error",
          errorMessage: "Account request failed; no account fallback was used.",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
    })
    .finally(() => release());
  return output;
}

export type AccountKind = "codex" | "anthropic-api";
export type ProviderAccount = {
  id: string;
  kind: AccountKind;
  name: string;
  provider: string;
  isDefault: boolean;
  removed?: boolean;
};
type State = { version: 1; accounts: ProviderAccount[]; migrated: boolean };
const baseProvider = (kind: AccountKind) => (kind === "codex" ? "openai-codex" : "anthropic");
const PREFIX = "desktop-account-";

/** Account metadata only. Credentials and token rotation remain owned by ModelRuntime. */
export class ProviderAccounts {
  private state: State;
  private runtimes = new Map<string, Promise<ModelRuntime>>();
  private originals = new WeakMap<ModelRuntime, Map<string, Provider>>();
  private leases = new Map<string, number>();
  private authenticating = new Set<string>();
  acquire(provider: string) {
    const account = this.find(provider);
    if (!account) return () => {};
    if (account.removed) throw new Error("Account removed; select an account explicitly");
    if (this.authenticating.has(account.id))
      throw new Error("Wait for this account's authentication change before sending a request");
    this.leases.set(account.id, (this.leases.get(account.id) ?? 0) + 1);
    return () => this.leases.set(account.id, Math.max(0, (this.leases.get(account.id) ?? 1) - 1));
  }
  private requireIdle(account: ProviderAccount) {
    if (this.leases.get(account.id) || this.authenticating.has(account.id))
      throw new Error("Wait for this account's current requests before changing its credentials or removing it");
  }
  private readonly file: string;
  private readonly agentDir: string;
  constructor(agentDir = getAgentDir()) {
    this.agentDir = agentDir;
    this.file = path.join(agentDir, "provider-accounts.json");
    try {
      const stored = existsSync(this.file)
        ? (JSON.parse(readFileSync(this.file, "utf8")) as State)
        : { version: 1, accounts: [], migrated: false };
      if (stored.version !== 1 || !Array.isArray(stored.accounts) || stored.accounts.length > 200) throw new Error();
      this.state = {
        version: 1,
        migrated: stored.migrated === true,
        accounts: stored.accounts.map((row) => {
          if (
            !["codex", "anthropic-api"].includes(row.kind) ||
            !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) ||
            (row.provider !== PREFIX + row.id &&
              !(row.id === `legacy-${row.kind}` && row.provider === baseProvider(row.kind)))
          )
            throw new Error();
          return {
            id: row.id,
            kind: row.kind,
            name: this.name(row.name),
            provider: row.provider,
            isDefault: row.isDefault === true,
            ...(row.removed ? { removed: true } : {}),
          };
        }),
      };
      if (new Set(this.state.accounts.map((row) => row.provider)).size !== this.state.accounts.length)
        throw new Error();
    } catch {
      throw new Error("Invalid or unsupported account configuration; configuration was not overwritten");
    }
  }
  private save() {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  private directory(account: ProviderAccount) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(account.id)) throw new Error("Invalid account ID");
    const directory = path.join(this.agentDir, "accounts", account.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return directory;
  }
  migrate() {
    if (this.state.migrated) return;
    const authFile = path.join(this.agentDir, "auth.json");
    let auth: Record<string, Credential>;
    try {
      auth = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : {};
    } catch {
      throw new Error("Legacy credential storage is unreadable; no account configuration was changed");
    }
    for (const kind of ["codex", "anthropic-api"] as const) {
      const provider = baseProvider(kind);
      const credential = auth[provider];
      if (!credential || (kind === "anthropic-api" && credential.type !== "api_key")) continue;
      // Stable IDs make a crash between credential copy and metadata commit idempotent.
      const account: ProviderAccount = { id: `legacy-${kind}`, kind, name: "Default", provider, isDefault: true };
      const target = path.join(this.directory(account), "auth.json");
      if (!existsSync(target))
        writeFileSync(target, JSON.stringify({ [provider]: credential }), { mode: 0o600, flag: "wx" });
      if (!this.state.accounts.some((row) => row.id === account.id)) this.state.accounts.push(account);
    }
    // Never rewrite the legacy auth file or conversation JSONL.
    this.state.migrated = true;
    this.save();
  }
  list() {
    this.migrate();
    return structuredClone(this.state.accounts.filter((row) => !row.removed));
  }
  find(provider: string) {
    this.migrate();
    return this.state.accounts.find((row) => row.provider === provider);
  }
  defaultProvider(provider: string) {
    if (!["openai-codex", "anthropic"].includes(provider) && !provider.startsWith(PREFIX)) return provider;
    const kind =
      this.find(provider)?.kind ??
      (provider === "openai-codex" ? "codex" : provider === "anthropic" ? "anthropic-api" : undefined);
    return this.state.accounts.find((row) => row.kind === kind && row.isDefault && !row.removed)?.provider ?? provider;
  }
  ensureLegacy(provider: string) {
    const existing = this.find(provider);
    if (existing) return existing;
    const kind: AccountKind | undefined =
      provider === "openai-codex" ? "codex" : provider === "anthropic" ? "anthropic-api" : undefined;
    if (!kind) return undefined;
    const account: ProviderAccount = {
      id: `legacy-${kind}`,
      kind,
      name: "Default",
      provider,
      isDefault: !this.list().some((row) => row.kind === kind && row.isDefault),
    };
    this.directory(account);
    this.state.accounts.push(account);
    this.save();
    return account;
  }
  add(kind: AccountKind, name: string) {
    if (!["codex", "anthropic-api"].includes(kind))
      throw new Error("Unsupported account type; Claude Code CLI is not Anthropic API");
    const normalized = this.name(name);
    this.migrate();
    const id = randomUUID();
    const account: ProviderAccount = {
      id,
      kind,
      name: normalized,
      provider: PREFIX + id,
      isDefault: !this.state.accounts.some((row) => row.kind === kind && !row.removed),
    };
    this.directory(account);
    this.state.accounts.push(account);
    this.save();
    return structuredClone(account);
  }
  private name(value: string) {
    if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error("Account name must contain 1–80 printable characters");
    return value.trim();
  }
  update(id: string, action: "rename" | "default" | "remove", name?: string) {
    this.migrate();
    const row = this.state.accounts.find((account) => account.id === id && !account.removed);
    if (!row) throw new Error("Account not found");
    if (action === "rename") row.name = this.name(name!);
    else if (action === "default") {
      for (const account of this.state.accounts) if (account.kind === row.kind) account.isDefault = account.id === id;
    } else if (action === "remove") throw new Error("Use the serialized account removal operation");
    else throw new Error("Invalid account action");
    this.save();
  }
  async runtime(account: ProviderAccount) {
    if (this.find(account.provider)?.removed)
      throw new Error("Account removed; history retained. Select an account explicitly.");
    let pending = this.runtimes.get(account.id);
    if (!pending) {
      pending = ModelRuntime.create({
        authPath: path.join(this.directory(account), "auth.json"),
        modelsPath: path.join(this.directory(account), "models.json"),
        allowModelNetwork: false,
      }).catch(() => {
        this.runtimes.delete(account.id);
        throw new Error("Account credential storage unavailable");
      });
      this.runtimes.set(account.id, pending);
    }
    return pending;
  }
  async status() {
    return Promise.all(
      this.list().map(async (account) => {
        const runtime = await this.runtime(account);
        const info = (await runtime.listCredentials()).find((row) => row.providerId === baseProvider(account.kind));
        return {
          ...account,
          loggedIn: !!info,
          authType: info?.type ?? (account.kind === "codex" ? "oauth" : "api_key"),
        };
      }),
    );
  }
  async login(provider: string, type: "oauth" | "api_key", interaction: AuthInteraction) {
    const account = this.find(provider);
    if (!account || account.removed) throw new Error("Account not available");
    this.requireIdle(account);
    if ((account.kind === "codex") !== (type === "oauth"))
      throw new Error("Authentication method does not match this account");
    this.authenticating.add(account.id);
    try {
      return await (await this.runtime(account)).login(baseProvider(account.kind), type, interaction);
    } finally {
      this.authenticating.delete(account.id);
    }
  }
  async logout(provider: string) {
    const account = this.find(provider);
    if (!account || account.removed) throw new Error("Account not available");
    this.requireIdle(account);
    this.authenticating.add(account.id);
    try {
      await this.clearCredentials(account);
    } finally {
      this.authenticating.delete(account.id);
    }
  }
  private async clearCredentials(account: ProviderAccount) {
    await (await this.runtime(account)).logout(baseProvider(account.kind));
    if (account.id.startsWith("legacy-")) {
      // Use SDK logout for the compatibility copy too, retaining unrelated providers.
      const legacy = await ModelRuntime.create({
        authPath: path.join(this.agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      await legacy.logout(baseProvider(account.kind));
    }
  }
  async remove(id: string) {
    this.migrate();
    const row = this.state.accounts.find((account) => account.id === id && !account.removed);
    if (!row) throw new Error("Account not found");
    this.requireIdle(row);
    this.authenticating.add(row.id);
    try {
      await this.clearCredentials(row);
      row.removed = true;
      row.isDefault = false;
      this.save(); // Tombstone first; keep historical binding identities, never reassign defaults.
      rmSync(path.join(this.directory(row), "auth.json"), { force: true });
      this.runtimes.delete(row.id);
    } finally {
      this.authenticating.delete(row.id);
    }
  }
  /** Provider IDs are stable account identities. Existing model binding keys need no rewrite. */
  async install(runtime: ModelRuntime) {
    this.migrate();
    let originals = this.originals.get(runtime);
    if (!originals) {
      originals = new Map(runtime.getProviders().map((provider) => [provider.id, provider]));
      this.originals.set(runtime, originals);
    }
    for (const account of this.state.accounts) {
      const scoped = account.removed
        ? await ModelRuntime.create({
            authPath: path.join(this.directory(account), "auth.json"),
            modelsPath: path.join(this.directory(account), "models.json"),
            allowModelNetwork: false,
          })
        : await this.runtime(account);
      const original = account.id.startsWith("legacy-")
        ? originals.get(baseProvider(account.kind))
        : scoped.getProvider(baseProvider(account.kind));
      if (!original) continue;
      const credential = async () =>
        !account.removed &&
        !!(await scoped!.listCredentials()).find((row) => row.providerId === baseProvider(account.kind));
      const provider: Provider = {
        id: account.provider,
        name: `${account.kind === "codex" ? "Codex" : "Anthropic API"} · ${account.name}${account.removed ? " (removed)" : ""}`,
        baseUrl: original.baseUrl,
        auth: {
          ...(account.kind === "codex" && original.auth.oauth
            ? {
                oauth: {
                  ...original.auth.oauth,
                  login: async () => {
                    throw new Error("Use Desktop's account login flow");
                  },
                  refresh: async () => {
                    if (!(await credential())) throw new Error("Account signed out or removed");
                    await scoped!.getAuth(baseProvider(account.kind));
                    return JSON.parse(readFileSync(path.join(this.directory(account), "auth.json"), "utf8"))[
                      baseProvider(account.kind)
                    ];
                  },
                  toAuth: async () => {
                    if (!(await credential())) throw new Error("Account signed out or removed; re-login this account");
                    try {
                      const result = await scoped!.getAuth(baseProvider(account.kind));
                      if (!result) throw new Error("Missing account authentication");
                      return result.auth;
                    } catch {
                      throw new Error("Account login expired or refresh failed; re-login this account");
                    }
                  },
                },
              }
            : {}),
          apiKey: {
            name: "Isolated account",
            check: async () =>
              (await credential()) ? { type: account.kind === "codex" ? "oauth" : "api_key" } : undefined,
            resolve: async () => {
              // Stored credentials are mandatory: no ambient key or account fallback.
              if (!(await credential()))
                throw new Error(
                  "Account signed out or removed. Re-login or select an account explicitly; no account fallback was used.",
                );
              try {
                return await scoped!.getAuth(baseProvider(account.kind));
              } catch {
                throw new Error(
                  "Account login expired or refresh failed. Re-login this account; no account fallback was used.",
                );
              }
            },
          },
        },
        getModels: () =>
          original
            .getModels()
            .map((model) => ({ ...model, provider: account.provider, name: `${model.name} · ${account.name}` })),
        stream: (model, context, options) =>
          accountStream(
            () => original.stream({ ...model, provider: baseProvider(account.kind) }, context, options),
            account.provider,
            model,
            () => this.acquire(account.provider),
          ),
        streamSimple: (model, context, options) =>
          accountStream(
            () => original.streamSimple({ ...model, provider: baseProvider(account.kind) }, context, options),
            account.provider,
            model,
            () => this.acquire(account.provider),
          ),
      };
      runtime.registerNativeProvider(provider);
    }
    await runtime.refresh({ allowNetwork: false });
  }
}
const stores = new Map<string, ProviderAccounts>();
export function providerAccounts(agentDir = getAgentDir()) {
  const directory = path.resolve(agentDir);
  let store = stores.get(directory);
  if (!store) {
    store = new ProviderAccounts(directory);
    stores.set(directory, store);
  }
  return store;
}
