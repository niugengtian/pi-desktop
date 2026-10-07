import { existsSync } from "node:fs";
import { providerAccounts } from "./provider-accounts.ts";
import { fileURLToPath } from "node:url";
import { createAgentSessionServices, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export function builtinWebProviderPath(): string {
  const compiled = fileURLToPath(new URL("./builtin-page-provider.mjs", import.meta.url));
  return existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL("../../plugins/page-provider/extensions/page-provider.ts", import.meta.url));
}

/** Ship Web models as a Desktop capability, including on a blank user profile. */
export function desktopResourceLoaderOptions(
  options: Partial<DefaultResourceLoaderOptions> = {},
  builtinPath = builtinWebProviderPath(),
): Partial<DefaultResourceLoaderOptions> {
  return {
    ...options,
    additionalExtensionPaths: [
      builtinPath,
      ...(options.additionalExtensionPaths ?? []).filter((p) => p !== builtinPath),
    ],
    extensionsOverride: (base) => {
      const result = options.extensionsOverride ? options.extensionsOverride(base) : base;
      // Older releases installed this same capability as a user package. Keep
      // its settings/files intact, but run only the shipped implementation.
      const superseded = new Set(
        result.extensions
          .filter(
            (extension) => extension.resolvedPath !== builtinPath && extension.commands.has("page-provider-binding"),
          )
          .map((extension) => extension.path),
      );
      result.runtime.pendingProviderRegistrations = result.runtime.pendingProviderRegistrations.filter(
        (registration) => !superseded.has(registration.extensionPath),
      );
      return { ...result, extensions: result.extensions.filter((extension) => !superseded.has(extension.path)) };
    },
  };
}

export async function createDesktopAgentServices(options: Parameters<typeof createAgentSessionServices>[0]) {
  const services = await createAgentSessionServices({
    ...options,
    resourceLoaderOptions: desktopResourceLoaderOptions(options.resourceLoaderOptions),
  });
  await providerAccounts().install(services.modelRuntime);
  return services;
}
