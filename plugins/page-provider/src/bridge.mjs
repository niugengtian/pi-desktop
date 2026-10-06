import { randomUUID, createHash } from "node:crypto";
import { WEB_CONTRACT } from "./tiered-contract.mjs";
import { spawn as nodeSpawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LINE_BYTES = 120 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_IMAGES = 8;
const SUPPORTED_SITES = new Set(["deepseek", "chatgpt", "gemini"]);

export const PAGE_PROVIDER_STATES = Object.freeze([
  "attaching",
  "ready",
  "sending",
  "waiting",
  "streaming",
  "completed",
  "loginRequired",
  "interrupted",
  "failed",
]);

const STATE_SET = new Set(PAGE_PROVIDER_STATES);

const WORKING_MESSAGES = Object.freeze({
  attaching: "Connecting to the OpenCLI page…",
  ready: "Web page connected",
  sending: "Sending to the web page…",
  waiting: "Waiting for the web model…",
  streaming: "Receiving the web response…",
  completed: "Web response received",
  loginRequired: "Web page login required",
  interrupted: "Web page connection interrupted",
  failed: "Web page request failed",
});

export function pageProviderWorkingMessage(state) {
  return WORKING_MESSAGES[state] ?? "Waiting for the web model…";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

export function latestUserInput(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content).trim();
    const parts = Array.isArray(message.content) ? message.content : [];
    const images = parts
      .filter((part) => part && typeof part === "object" && part.type === "image")
      .map((part) => ({
        mimeType: String(part.mimeType ?? ""),
        data: String(part.data ?? ""),
      }));
    if (text || images.length > 0) return { text, images };
  }
  throw new Error("Page Provider requires a non-empty text or image message.");
}

export function latestUserText(context) {
  const input = latestUserInput(context);
  if (!input.text) throw new Error("Page Provider requires a non-empty text message.");
  return input.text;
}

function isCanonicalBase64(value) {
  if (!value || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  if (images.length > MAX_IMAGES) {
    throw new Error(`Page Provider supports at most ${MAX_IMAGES} images per turn.`);
  }
  let totalBytes = 0;
  const normalized = images.map((image) => {
    const mimeType = String(image?.mimeType ?? "").toLowerCase();
    const data = String(image?.data ?? "");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mimeType)) {
      throw new Error(`Page Provider does not support image type: ${mimeType || "unknown"}.`);
    }
    if (!isCanonicalBase64(data)) {
      throw new Error("Page Provider images must contain canonical base64 data.");
    }
    const size = Buffer.from(data, "base64").byteLength;
    if (size === 0 || size > MAX_IMAGE_BYTES) {
      throw new Error("Each Page Provider image must be between 1 byte and 10 MiB.");
    }
    totalBytes += size;
    return { kind: "image", mimeType, data };
  });
  if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
    throw new Error("Page Provider images may total at most 80 MiB per turn.");
  }
  return normalized;
}

export function assistantMessage(model, markdown) {
  return {
    role: "assistant",
    content: [{ type: "text", text: markdown }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function parseEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new Error("Page Provider bridge emitted invalid JSON.");
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new Error("Page Provider bridge emitted an invalid event.");
  }
  return event;
}

async function runPageProviderRequest({
  method,
  text,
  images,
  mode = "chat",
  site = "deepseek",
  conversationId,
  newConversation = false,
  dedupe = false,
  deliveryContract,
  beforeDispatch,
  signal,
  onState = () => {},
  onRemote = () => {},
  command = process.env.PI_PAGE_PROVIDER_BRIDGE || "pi-opencli-bridge",
  args = ["--stdio"],
  spawn = nodeSpawn,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!["turn.send", "provider.probe", "provider.open", "provider.new"].includes(method)) {
    throw new Error(`Unsupported Page Provider method: ${method}`);
  }
  const prompt = String(text ?? "").trim();
  const normalizedSite = String(site ?? "deepseek")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_SITES.has(normalizedSite)) {
    throw new Error(`Unsupported Page Provider site: ${normalizedSite || "empty"}`);
  }
  const normalizedMode = String(mode ?? "chat")
    .trim()
    .toLowerCase();
  if (method === "turn.send" && !["chat", "reasoner"].includes(normalizedMode)) {
    throw new Error(`Unsupported Page Provider mode: ${normalizedMode || "empty"}`);
  }
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (
    (method === "provider.open" || (method === "turn.send" && normalizedConversationId)) &&
    (!normalizedConversationId ||
      normalizedConversationId.length > 256 ||
      !/^[a-z0-9_-]+$/i.test(normalizedConversationId))
  ) {
    throw new Error("Page Provider requires a valid remote conversation ID.");
  }
  if (method === "turn.send" && newConversation && normalizedConversationId) {
    throw new Error("Page Provider cannot create and resume a conversation in the same turn.");
  }
  const attachments = method === "turn.send" ? normalizeImages(images) : [];
  if (method === "turn.send" && !prompt && attachments.length === 0) {
    throw new Error("Page Provider cannot send an empty prompt.");
  }

  const requestId = randomUUID();
  const request = {
    id: requestId,
    method,
    params:
      method === "turn.send"
        ? {
            text: prompt,
            attachments,
            mode: normalizedMode,
            site: normalizedSite,
            dedupe: dedupe === true,
            newConversation: newConversation === true,
            ...(normalizedConversationId ? { conversationId: normalizedConversationId } : {}),
            ...(deliveryContract ? { deliveryContract } : {}),
          }
        : method === "provider.open"
          ? { site: normalizedSite, conversationId: normalizedConversationId }
          : { site: normalizedSite },
  };

  const strict = deliveryContract === WEB_CONTRACT;
  if (
    deliveryContract &&
    (!strict ||
      method !== "turn.send" ||
      typeof beforeDispatch !== "function" ||
      (!newConversation && !normalizedConversationId) ||
      (newConversation && normalizedConversationId) ||
      dedupe)
  )
    throw new Error("Tiered Web dispatch contract/route is invalid.");
  return new Promise((resolve, reject) => {
    let permitted = false;
    let settled = false;
    let stdoutBuffer = "";
    let completed;

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env,
    });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };

    const abort = () => {
      child.kill("SIGTERM");
      finish(new DOMException("Page Provider turn was cancelled.", "AbortError"));
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Page Provider bridge timed out."));
    }, timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finish(
          new Error(
            `Page Provider bridge was not found: ${command}. Set PI_PAGE_PROVIDER_BRIDGE to a compatible executable.`,
          ),
        );
        return;
      }
      finish(error);
    });

    // Drain stderr so a noisy bridge cannot block on a full pipe. Its contents
    // are intentionally not surfaced because a third-party bridge could echo
    // prompt text or browser data there.
    child.stderr.resume();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_LINE_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Page Provider bridge emitted an oversized event."));
        return;
      }

      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;

        let event;
        try {
          event = parseEvent(line);
        } catch (error) {
          child.kill("SIGTERM");
          finish(error);
          return;
        }

        const correlationId = String(event.turnId ?? event.id ?? "");
        if (correlationId && correlationId !== requestId) {
          child.kill("SIGTERM");
          finish(new Error("Page Provider bridge emitted an event for another request."));
          return;
        }

        if (event.type === "turn.dispatch_ready") {
          try {
            if (
              !strict ||
              permitted ||
              signal?.aborted ||
              correlationId !== requestId ||
              JSON.stringify(event.request) !== JSON.stringify(request)
            )
              throw new Error("Web dispatch frame changed.");
            const returned = beforeDispatch(JSON.parse(JSON.stringify(request)));
            if (returned !== undefined)
              throw new Error("Web dispatch guard must complete synchronously and throw on refusal.");
            permitted = true;
            child.stdin.end(
              JSON.stringify({
                id: requestId,
                method: "turn.dispatch",
                promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
              }) + "\n",
              "utf8",
            );
          } catch (error) {
            child.kill("SIGTERM");
            finish(error);
          }
          continue;
        }
        if (event.type === "provider.state" || event.type === "turn.status") {
          const state = String(event.state ?? event.status ?? "");
          if (STATE_SET.has(state)) onState(state);
          continue;
        }
        if (event.type === "turn.delta") {
          onState("streaming");
          continue;
        }
        if (event.type === "turn.remote") {
          const remote = event.remote && typeof event.remote === "object" ? event.remote : {};
          const remoteId = String(remote.conversationId ?? "");
          const remoteUrl = String(remote.conversationUrl ?? "");
          let validUrl = false;
          try {
            const url = new URL(remoteUrl);
            validUrl =
              url.protocol === "https:" &&
              ((normalizedSite === "deepseek" && url.hostname === "chat.deepseek.com") ||
                (normalizedSite === "chatgpt" &&
                  (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com"))) ||
                (normalizedSite === "gemini" && url.hostname === "gemini.google.com"));
          } catch {
            validUrl = false;
          }
          if (!/^[a-z0-9_-]{1,256}$/i.test(remoteId) || !validUrl) {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge returned invalid remote conversation metadata."));
            return;
          }
          onRemote({ ...remote, site: normalizedSite, conversationId: remoteId, conversationUrl: remoteUrl });
          continue;
        }
        if (event.type === "turn.failed") {
          const code = String(event.error?.code ?? "BRIDGE_ERROR");
          const message = String(event.error?.message ?? "Page Provider bridge failed.");
          onState(code === "LOGIN_REQUIRED" ? "loginRequired" : "failed");
          child.kill("SIGTERM");
          finish(new Error(`${code}: ${message}`));
          return;
        }
        if (event.type === "turn.completed") {
          if (method !== "turn.send") {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge returned a turn result for a different request method."));
            return;
          }
          const markdown = String(event.message?.markdown ?? "");
          if (!markdown.trim()) {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge completed without a Markdown response."));
            return;
          }
          if (
            strict &&
            (!permitted ||
              correlationId !== requestId ||
              event.receipt?.schema !== WEB_CONTRACT ||
              event.receipt.promptHash !== createHash("sha256").update(prompt, "utf8").digest("hex") ||
              event.receipt.responseHash !== createHash("sha256").update(markdown, "utf8").digest("hex"))
          ) {
            child.kill("SIGTERM");
            finish(new Error("Web response lacks a matching gated receipt."));
            return;
          }
          completed = {
            ...(strict ? { receipt: event.receipt } : {}),
            turnId: requestId,
            markdown,
            remote: event.remote && typeof event.remote === "object" ? event.remote : {},
          };
          onState("completed");
          child.kill("SIGTERM");
          finish(undefined, completed);
          return;
        }
        if (event.type === "provider.probed") {
          if (method !== "provider.probe") {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge returned a probe result for a different request method."));
            return;
          }
          const state = String(event.state ?? "");
          if (!STATE_SET.has(state)) {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge returned an invalid probe state."));
            return;
          }
          completed = { state };
          child.kill("SIGTERM");
          finish(undefined, completed);
          return;
        }
        if (event.type === "provider.opened") {
          const openedSite = String(event.provider?.site ?? "");
          const openedConversationId = String(event.provider?.conversationId ?? "");
          if (
            method !== "provider.open" ||
            openedSite !== normalizedSite ||
            openedConversationId !== normalizedConversationId
          ) {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge opened an unexpected conversation."));
            return;
          }
          completed = { site: openedSite, conversationId: openedConversationId };
          child.kill("SIGTERM");
          finish(undefined, completed);
          return;
        }
        if (event.type === "provider.started") {
          const startedSite = String(event.provider?.site ?? "");
          if (method !== "provider.new" || startedSite !== normalizedSite) {
            child.kill("SIGTERM");
            finish(new Error("Page Provider bridge started an unexpected conversation."));
            return;
          }
          completed = { site: startedSite };
          child.kill("SIGTERM");
          finish(undefined, completed);
          return;
        }
      }
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      if (completed) {
        finish(undefined, completed);
        return;
      }
      finish(
        new Error(
          `Page Provider bridge exited before completing the turn (code ${code ?? "unknown"}${
            closeSignal ? `, signal ${closeSignal}` : ""
          }).`,
        ),
      );
    });

    onState(method === "turn.send" ? "sending" : "attaching");
    if (strict) child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    else child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

export function runPageProviderTurn(options) {
  return runPageProviderRequest({ ...options, method: "turn.send" });
}

export function probePageProvider(options = {}) {
  return runPageProviderRequest({ ...options, method: "provider.probe" });
}

export function openPageProviderConversation(options) {
  return runPageProviderRequest({ ...options, method: "provider.open" });
}

export function startNewPageProviderConversation(options) {
  return runPageProviderRequest({ ...options, method: "provider.new" });
}
