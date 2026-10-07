import { ModelSessions } from "./memory/model-sessions.mjs";
import { providerAccounts } from "./provider-accounts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDesktopAgentServices } from "./builtin-web-provider";
import { appendFileSync } from "node:fs";
import { createDesktopPromptExtension, type SessionPromptPolicy } from "./session-prompt-policy";
import { createTieredWorkspaceExtension } from "./memory/tiered-extension";
import { TieredBudgetController, supportsTieredModel } from "./memory/tiered-budget-controller";
import { createFlashWarmRunner } from "./memory/tiered-warm-remote.mjs";
import { memoryModelConsentEpoch } from "./handlers/memory-model";
import { createEphemeralContextExtension, type SessionEphemeralContext } from "./session-ephemeral-context";
import { createLegacyChannelContextExtension } from "./legacy-channel-context";

/** Compose the existing native memory services before restoring a saved model. */
export async function createDesktopSessionServices(
  cwd: string,
  agentDir: string,
  promptPolicy: SessionPromptPolicy,
  ephemeralContext: SessionEphemeralContext,
) {
  let validationMemoryRuntime: Promise<ModelRuntime> | undefined;
  const getRemoteMemoryRuntime = (): ModelRuntime | Promise<ModelRuntime> => {
    const authPath = process.env.PI_MEMORY_TEST_AUTH_PATH;
    if (process.env.PI_MEMORY_TEST_MODE === "1" && authPath) {
      validationMemoryRuntime ??= ModelRuntime.create({
        modelsPath: null,
        authPath,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      return validationMemoryRuntime;
    }
    return memoryRuntime;
  };
  const tieredBudget: TieredBudgetController = new TieredBudgetController({
    adaptive: true,
    automatic: true,
    warmRunner: (options) => async (plan) =>
      createFlashWarmRunner({
        ...options,
        runtime: await getRemoteMemoryRuntime(),
        onEvent: (event) => {
          console.info("[tiered-warm]", JSON.stringify(event));
          const auditPath = process.env.PI_TIERED_TEST_AUDIT_PATH;
          if (process.env.PI_MEMORY_TEST_MODE === "1" && auditPath)
            appendFileSync(auditPath, JSON.stringify(event) + "\n", { mode: 0o600 });
        },
      })(plan),
    consentVersion: memoryModelConsentEpoch,
    supports: (model) =>
      supportsTieredModel(model) ||
      (process.env.PI_MEMORY_TEST_MODE === "1" &&
        model.provider === "tier-compare-codex" &&
        model.api === "openai-codex-responses" &&
        /^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(model.baseUrl ?? "")),
  });
  const modelSessions = new ModelSessions({ acquire: (provider) => providerAccounts().acquire(provider) });
  const extensionFactories = [
    modelSessions.extension(),
    createLegacyChannelContextExtension(),
    createEphemeralContextExtension(ephemeralContext),
    createDesktopPromptExtension(promptPolicy),
    createTieredWorkspaceExtension(),
    tieredBudget.extension(),
  ];
  const nativeServices = await createDesktopAgentServices({
    cwd,
    agentDir,
    resourceLoaderOptions: { extensionFactories },
  });
  const services = {
    ...nativeServices,
    settingsManager: tieredBudget.wrapSettings(nativeServices.settingsManager),
  };
  const memoryRuntime: ModelRuntime = services.modelRuntime;
  return { services, tieredBudget, modelSessions };
}
