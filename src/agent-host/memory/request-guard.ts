import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Model,
  type Api,
  type TranscriptContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Guard at the real runtime dispatch, not an extension event whose errors Pi swallows. */
export function installMemoryRequestGuard(
  runtime: Pick<ModelRuntime, "streamSimple">,
  prepare: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => Promise<TranscriptContext>,
  delivered: (model: Model<Api>) => void = () => {},
  blocked: (error: unknown) => void = () => {},
) {
  const original = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const outgoing = await prepare(model, normalizeContext(context), options);
        options?.signal?.throwIfAborted();
        const delegated = original(model, outgoing, options);
        for await (const event of delegated) {
          stream.push(event);
          if (event.type === "done") {
            try {
              delivered(model);
            } catch {
              /* An observer must not corrupt the provider result. */
            }
          }
        }
        stream.end();
      } catch (error) {
        try {
          blocked(error);
        } catch {
          /* A disconnected UI must not leave the stream waiting forever. */
        }
        const aborted = options?.signal?.aborted === true;
        const output = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: aborted ? ("aborted" as const) : ("error" as const),
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
        stream.end();
      }
    })();
    return stream;
  };
}
