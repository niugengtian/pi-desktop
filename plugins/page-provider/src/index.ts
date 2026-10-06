import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistantMessage,
  latestUserInput,
  pageProviderWorkingMessage,
  probePageProvider,
  runPageProviderTurn,
} from "./bridge.mjs";

type PageProviderDefinition = {
  id: string;
  name: string;
  models: Array<Record<string, unknown>>;
  complete: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
};

type ExtensionUi = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setWorkingMessage(text?: string): void;
};

type ExtensionContext = {
  model?: { id?: string; provider?: string };
  signal?: AbortSignal;
  ui: ExtensionUi;
};

type PageProviderApi = {
  registerAgent(definition: PageProviderDefinition): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, context: ExtensionContext) => void | Promise<void>;
    },
  ): void;
  on(event: "before_agent_start" | "turn_end", handler: (event: unknown, context: ExtensionContext) => void): void;
};

const bundledBridge = fileURLToPath(new URL("../bridge/opencli-bridge.mjs", import.meta.url));

function bridgeLaunch() {
  const override = String(process.env.PI_PAGE_PROVIDER_BRIDGE ?? "").trim();
  if (override) return { command: override, args: ["--stdio"] };

  const configuredNode = String(process.env.PI_PAGE_PROVIDER_NODE ?? "").trim();
  if (configuredNode) return { command: configuredNode, args: [bundledBridge, "--stdio"] };
  if (/^node(?:\.exe)?$/i.test(basename(process.execPath))) {
    return { command: process.execPath, args: [bundledBridge, "--stdio"] };
  }
  const candidates = [
    join(homedir(), ".hermes", "node", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  const node = candidates.find((candidate) => existsSync(candidate));
  if (node) return { command: node, args: [bundledBridge, "--stdio"] };
  if (process.versions.electron) {
    return {
      command: process.execPath,
      args: [bundledBridge, "--stdio"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: "node", args: [bundledBridge, "--stdio"] };
}

export default function registerPageProvider(pi: PageProviderApi) {
  let activeUi: ExtensionUi | undefined;
  let providerState = "disconnected";
  const site = String(process.env.PI_PAGE_PROVIDER_SITE ?? "deepseek")
    .trim()
    .toLowerCase();
  const models =
    site === "deepseek"
      ? [
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            api: "openai-completions",
            input: ["text", "image"],
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
          {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            api: "openai-completions",
            input: ["text", "image"],
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        ]
      : [
          {
            id: "current-page",
            name: "Current Web Page",
            api: "openai-completions",
            input: ["text", "image"],
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        ];
  const modelIds = new Set(models.map((model) => model.id));

  pi.registerCommand("page-provider-status", {
    description: "Show the current OpenCLI Page Provider state",
    handler: async (_args, context) => {
      context.ui.setWorkingMessage("Checking the OpenCLI page…");
      try {
        const result = await probePageProvider({
          signal: context.signal,
          onState: (state: string) => {
            providerState = state;
            context.ui.setWorkingMessage(pageProviderWorkingMessage(state));
          },
          timeoutMs: 30_000,
          ...bridgeLaunch(),
        });
        providerState = result.state;
        const level = result.state === "ready" ? "info" : "warning";
        context.ui.notify(`Page Provider: ${result.state} · ${site}`, level);
      } catch (error: unknown) {
        providerState = "failed";
        context.ui.notify(error instanceof Error ? error.message : "Page Provider probe failed.", "error");
      } finally {
        context.ui.setWorkingMessage();
      }
    },
  });

  pi.on("before_agent_start", (_event, context) => {
    const model = context.model;
    if (!model?.id || !modelIds.has(model.id) || !model.provider?.startsWith("extension-agent:")) {
      activeUi = undefined;
      return;
    }
    activeUi = context.ui;
    providerState = "attaching";
    activeUi.setWorkingMessage(pageProviderWorkingMessage(providerState));
  });
  pi.on("turn_end", () => {
    activeUi?.setWorkingMessage();
    activeUi = undefined;
  });

  pi.registerAgent({
    id: "opencli-page",
    name: "OpenCLI Page",
    models,
    complete: async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const input = latestUserInput(context);
      const result = await runPageProviderTurn({
        text: input.text,
        images: input.images,
        mode: model.id === "deepseek-reasoner" ? "reasoner" : "chat",
        signal: options?.signal,
        onState: (state: string) => {
          providerState = state;
          activeUi?.setWorkingMessage(pageProviderWorkingMessage(state));
        },
        ...bridgeLaunch(),
      }).catch((error: unknown) => {
        if (providerState !== "loginRequired") providerState = "failed";
        throw error;
      });
      return assistantMessage(model, result.markdown);
    },
  });
}
