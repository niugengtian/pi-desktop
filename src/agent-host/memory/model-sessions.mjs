import { randomUUID } from "node:crypto";
import { imageId, imageBatches, isImageBlock } from "./tiered-images.mjs";
const ENTRY = "desktop-model-sessions";
const keyOf = (model) => `${model.provider}/${model.id}`;
/** One active binding, with saved per-model identities and acknowledged image cursors. */
export class ModelSessions {
  session;
  active;
  sendImages = [];
  records = new Map();
  archived = [];
  restore(manager) {
    const source = manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === ENTRY)
      .at(-1)?.data;
    this.hasSaved = source?.piSessionId === manager.getSessionId();
    const saved = source?.piSessionId === manager.getSessionId() ? structuredClone(source) : undefined;
    this.records = new Map((saved?.records ?? []).map((record) => [record.key, record]));
    this.active = saved?.active;
    this.archived = saved?.archived ?? [];
  }
  save() {
    this.session.sessionManager.appendCustomEntry(
      ENTRY,
      structuredClone({
        piSessionId: this.session.sessionId,
        active: this.active,
        records: [...this.records.values()],
        archived: this.archived,
      }),
    );
  }
  select(model) {
    const key = keyOf(model);
    let record = this.records.get(key);
    if (!record) {
      record = { key, id: randomUUID(), delivered: [] };
      this.records.set(key, record);
    }
    if (this.active !== key) {
      this.active = key;
      this.save();
    }
    return record;
  }
  currentId() {
    const record = this.active ? this.records.get(this.active) : undefined;
    return record?.remote?.conversationId ?? record?.id;
  }
  install(session) {
    this.session = session;
    this.restore(session.sessionManager);
    if (!this.records.size && !this.archived.length) {
      const initial = session.sessionManager.getEntries().find((entry) => entry.type === "model_change");
      const key = initial ? `${initial.provider}/${initial.modelId}` : session.model ? keyOf(session.model) : undefined;
      if (key) this.records.set(key, { key, id: session.sessionId, delivered: [] });
    }
    if (session.model && (!this.hasSaved || this.active)) this.select(session.model);
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
      if (text.startsWith("/") || !session.model || options?.streamingBehavior) return prompt(text, options);
      const record = this.select(session.model);
      const images = new Map();
      let hasOriginalLedger = false;
      for (const entry of session.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "desktop-original-images") {
          hasOriginalLedger = true;
          for (const image of entry.data.images) images.set(imageId(image), image);
        }
        const content =
          entry.type === "message" && (!hasOriginalLedger || entry.message.role === "toolResult")
            ? entry.message.content
            : undefined;
        if (Array.isArray(content))
          for (const image of content) if (image.type === "image") images.set(imageId(image), image);
      }
      const originals = (options?.images ?? []).filter((image) => !images.has(imageId(image)));
      if (originals.length)
        session.sessionManager.appendCustomEntry("desktop-original-images", {
          text,
          images: structuredClone(originals),
        });
      for (const image of options?.images ?? []) images.set(imageId(image), image);
      const pending = [...images].filter(([id]) => !record.delivered.includes(id)).map(([, image]) => image);
      const batches = imageBatches(pending);
      const success = () => {
        const last = [...session.sessionManager.buildSessionProjection().messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (!last || ["error", "aborted"].includes(last.stopReason))
          throw new Error(last?.errorMessage ?? "Image transmission interrupted");
        if (session.model.provider === "opencli-page") {
          const replyText =
            last.content
              ?.filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n") ?? "";
          if (replyText.includes("<!-- PAGE_PROVIDER_TURN_UNCONFIRMED -->"))
            throw new Error("Web image delivery is unconfirmed; image cursor was not advanced");
          const binding = session.sessionManager
            .getBranch()
            .filter(
              (e) =>
                e.type === "custom" &&
                ["page-provider-binding", "page-provider-binding-provisional"].includes(e.customType) &&
                e.data?.modelId === session.model.id,
            )
            .at(-1)?.data;
          if (binding) record.remote = structuredClone(binding.remote);
        }
        record.delivered = [...new Set([...record.delivered, ...this.sendImages.map(imageId)])];
        this.save();
      };
      const tools = session.getActiveToolNames();
      try {
        if (batches.length > 1) {
          session.setActiveToolsByName([]);
          for (let index = 0; index < batches.length; index++) {
            this.sendImages = batches[index];
            await prompt(
              `Image transfer ${index + 1}/${batches.length}. Record the visual content of each image, including readable text and details needed for later reasoning. Keep the image order. Do not perform the final task yet; wait for the user's final request.`,
              { ...options, images: batches[index] },
            );
            success();
          }
          session.setActiveToolsByName(tools);
          this.sendImages = [];
          await prompt(text, { ...options, images: options?.images });
        } else {
          this.sendImages = batches[0] ?? [];
          await prompt(text, options);
          success();
        }
      } finally {
        this.sendImages = [];
        session.setActiveToolsByName(tools);
      }
    };
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      const record = this.select(model);
      if (model.provider === "opencli-page") return stream(model, context, { ...options, pageImages: this.sendImages });
      // Keep newly produced tool images in their original tool-result positions.
      const toolImages = context.messages
        .filter((message) => message.role === "toolResult")
        .flatMap((message) => (Array.isArray(message.content) ? message.content.filter(isImageBlock) : []))
        .filter((image) => !record.delivered.includes(imageId(image)));
      const uniqueToolImages = new Map(toolImages.map((image) => [imageId(image), image]));
      if (uniqueToolImages.size > 8) throw new Error("A tool result contains more than 8 new images");
      const activeUserImages = new Map(
        context.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => (Array.isArray(message.content) ? message.content.filter(isImageBlock) : []))
          .map((image) => [imageId(image), image]),
      );
      const replay = this.sendImages.length
        ? this.sendImages
        : activeUserImages.size + uniqueToolImages.size <= 8
          ? [...activeUserImages.values()]
          : [];
      const userImages = replay.filter((image) => !uniqueToolImages.has(imageId(image)));
      const injectedImages = userImages.length + uniqueToolImages.size > 8 ? [] : userImages;
      this.sendImages = [
        ...new Map([...this.sendImages, ...toolImages].map((image) => [imageId(image), image])).values(),
      ];
      // Replay only this round's images. Original media always remains in JSONL.
      const messages = context.messages.map((message) => ({
        ...message,
        ...(Array.isArray(message.content)
          ? {
              content: message.content.map((block) =>
                isImageBlock(block) && !(message.role === "toolResult" && uniqueToolImages.has(imageId(block)))
                  ? { type: "text", text: `[Image ${imageId(block)} retained in original transcript]` }
                  : block,
              ),
            }
          : {}),
      }));
      if (injectedImages.length) {
        const user = [...messages].reverse().find((message) => message.role === "user");
        if (user)
          user.content = [
            ...(typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content),
            ...injectedImages,
          ];
      }
      return stream(model, { ...context, messages }, { ...options, desktopModelSessionId: record.id });
    };
  }
  extension() {
    return {
      name: "desktop-model-session-bindings",
      hidden: true,
      factory: (pi) => {
        pi.on("model_select", ({ model }) => {
          if (this.session && model) this.select(model);
        });
        pi.registerCommand("model-session", {
          description: "List, detach or rebind the current model session: list | unbind | bind <id>",
          handler: async (args, ctx) => {
            const [action = "list", id] = args.trim().split(/\s+/);
            if (!ctx.isIdle()) throw new Error("Wait for the current turn before changing session bindings");
            if (action === "unbind") {
              if (this.session.model.provider === "opencli-page")
                this.session.sessionManager.appendCustomEntry("page-provider-binding-reset", {
                  modelId: this.session.model.id,
                });
              if (this.active) {
                this.archived.push(this.records.get(this.active));
                this.records.delete(this.active);
              }
              this.active = undefined;
              this.save();
            } else if (action === "bind") {
              const record = [...this.records.values(), ...this.archived].find(
                (row) => (row.id === id || row.remote?.conversationId === id) && row.key === keyOf(this.session.model),
              );
              if (!record) throw new Error("No saved session for the selected model with this ID");
              const previous = this.records.get(record.key);
              if (previous && previous.id !== record.id) this.archived.push(previous);
              if (record.remote)
                this.session.sessionManager.appendCustomEntry("page-provider-binding", {
                  schemaVersion: 1,
                  sessionId: this.session.sessionId,
                  modelId: this.session.model.id,
                  remote: structuredClone(record.remote),
                  updatedAt: new Date().toISOString(),
                });
              this.records.set(record.key, record);
              this.archived = this.archived.filter((row) => row.id !== record.id);
              this.active = record.key;
              this.save();
            }
            ctx.ui.notify(
              JSON.stringify({
                active: this.currentId(),
                sessions: [...this.records.values(), ...this.archived].map(({ key, id, remote }) => ({
                  model: key,
                  id: remote?.conversationId ?? id,
                })),
              }),
              "info",
            );
          },
        });
      },
    };
  }
}
