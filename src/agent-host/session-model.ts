// A model picker refresh uses a separate runtime from an already-open session.
// Re-read the persisted catalog before rejecting a newly published model.
export async function resolveSessionModel<T>(
  runtime: {
    getModel(provider: string, modelId: string): T | undefined;
    refresh(options: { allowNetwork: false; providers: string[] }): Promise<unknown>;
  },
  provider: string,
  modelId: string,
): Promise<T> {
  let model = runtime.getModel(provider, modelId);
  if (!model) {
    await runtime.refresh({ allowNetwork: false, providers: [provider] });
    model = runtime.getModel(provider, modelId);
  }
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  return model;
}
