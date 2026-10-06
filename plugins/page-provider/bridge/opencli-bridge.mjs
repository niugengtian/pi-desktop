#!/usr/bin/env node

/**
 * Narrow Page Provider bridge for an externally installed OpenCLI package.
 *
 * The prompt arrives over stdin and is passed to OpenCLI's adapter execution
 * API in memory. It never appears in a shell command or child-process argv.
 * OpenCLI remains an external dependency and continues to own browser access,
 * login state, site adapters, and response extraction.
 */

import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { WEB_CONTRACT, hashText } from "../src/tiered-contract.mjs";
import { prepareBuiltinAdapter } from "./builtin-adapters.mjs";
let frames;
let rawRequest;
let cleanupAdapter = async () => {};

const MAX_REQUEST_BYTES = 120 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_IMAGES = 8;
const SUPPORTED_SITES = new Set(["deepseek", "chatgpt", "gemini"]);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(code, message, recoverable = true) {
  emit({ type: "turn.failed", error: { code, message, recoverable } });
  process.exitCode = 1;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function acquireSiteLock(site) {
  const lockDir = join(tmpdir(), `pi-page-provider-${site}.lock`);
  const ownerPath = join(lockDir, "owner.json");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, "utf8"));
          if (owner?.token === token) await rm(lockDir, { recursive: true, force: true });
        } catch {
          // The lock may already have been reclaimed after process shutdown.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(ownerPath, "utf8"));
      } catch {
        // The winning process may still be writing its owner record.
        await sleep(100);
        continue;
      }
      const ownerPid = Number(owner?.pid);
      let alive = Number.isSafeInteger(ownerPid) && ownerPid > 0;
      if (alive) {
        try {
          process.kill(ownerPid, 0);
        } catch (probeError) {
          if (probeError?.code === "ESRCH") alive = false;
        }
      }
      if (!alive) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleep(100);
    }
  }
}

async function executableOnPath(name) {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const entry of String(process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      try {
        await access(candidate, fsConstants.X_OK);
        return realpath(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

async function packageRootFrom(start) {
  let cursor = resolve(start);
  for (;;) {
    const manifestPath = join(cursor, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest?.name === "@jackwener/opencli") return cursor;
    } catch {
      // Walk upward until the OpenCLI package root is found.
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function resolveOpenCliRoot() {
  const configured = String(process.env.OPENCLI_PACKAGE_ROOT ?? "").trim();
  if (configured) {
    const root = await packageRootFrom(configured);
    if (root) return root;
    throw new Error("OPENCLI_PACKAGE_ROOT does not point inside an @jackwener/opencli package.");
  }

  // OpenCLIApp installs its managed package here while exposing only a native
  // shim in /usr/local/bin. Checking the package directly also makes the bridge
  // independent of the narrower PATH inherited by packaged desktop apps.
  const managedRoot = join(homedir(), ".opencli", "node_modules", "@jackwener", "opencli");
  const managedPackage = await packageRootFrom(managedRoot);
  if (managedPackage) return managedPackage;

  const binary = await executableOnPath("opencli");
  if (!binary) throw new Error("OpenCLI is not installed or is not available on PATH.");
  const root = await packageRootFrom(dirname(binary));
  if (!root) throw new Error("Could not resolve the @jackwener/opencli package from its executable.");
  return root;
}

async function readRequest() {
  process.stdin.setEncoding("utf8");
  const channel = createInterface({ input: process.stdin, crlfDelay: Infinity });
  frames = channel[Symbol.asyncIterator]();
  const first = await frames.next();
  if (first.done || Buffer.byteLength(first.value, "utf8") > MAX_REQUEST_BYTES)
    throw new Error("Missing or oversized NDJSON request.");
  const request = JSON.parse(first.value);
  rawRequest = request;
  if (!request?.params?.deliveryContract) {
    if (!(await frames.next()).done) throw new Error("Expected exactly one NDJSON request.");
  } else if (request.method !== "turn.send") throw new Error("Invalid gated Web method.");
  const method = String(request?.method ?? "");
  const site = String(request?.params?.site ?? process.env.PI_PAGE_PROVIDER_SITE ?? "deepseek")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_SITES.has(site)) {
    throw new Error("Page Provider received an unsupported site profile.");
  }
  if (method === "provider.probe" || method === "provider.new") {
    return { id: String(request.id ?? ""), method, site };
  }
  if (method === "provider.open") {
    const conversationId = String(request?.params?.conversationId ?? "").trim();
    if (!conversationId || conversationId.length > 256 || !/^[a-z0-9_-]+$/i.test(conversationId)) {
      throw new Error("Page Provider received an invalid conversation ID.");
    }
    if (site === "gemini") {
      throw new Error("Page Provider does not yet support opening Gemini conversations.");
    }
    return { id: String(request.id ?? ""), method, site, conversationId };
  }
  if (method !== "turn.send") throw new Error("Unsupported Page Provider method.");
  const text = String(request?.params?.text ?? "").trim();
  const mode = String(request?.params?.mode ?? "chat")
    .trim()
    .toLowerCase();
  if (!["chat", "reasoner"].includes(mode)) {
    throw new Error("Page Provider received an unsupported model mode.");
  }
  const conversationId = String(request?.params?.conversationId ?? "").trim();
  const newConversation = request?.params?.newConversation === true;
  if (conversationId && (conversationId.length > 256 || !/^[a-z0-9_-]+$/i.test(conversationId))) {
    throw new Error("Page Provider received an invalid conversation ID.");
  }
  if (conversationId && newConversation) {
    throw new Error("Page Provider cannot create and resume a conversation in the same turn.");
  }
  const deliveryContract = request?.params?.deliveryContract;
  if (
    deliveryContract &&
    (deliveryContract !== WEB_CONTRACT ||
      (!newConversation && !conversationId) ||
      (newConversation && conversationId) ||
      request.params.dedupe)
  )
    throw new Error("Invalid gated Web route.");
  const attachments = Array.isArray(request?.params?.attachments) ? request.params.attachments : [];
  if (attachments.length > MAX_IMAGES) {
    throw new Error(`Page Provider supports at most ${MAX_IMAGES} images per turn.`);
  }
  let totalBytes = 0;
  const normalizedAttachments = attachments.map((attachment) => {
    const mimeType = String(attachment?.mimeType ?? "").toLowerCase();
    const data = String(attachment?.data ?? "");
    if (attachment?.kind !== "image" || !/^image\/(png|jpeg|webp|gif)$/.test(mimeType)) {
      throw new Error("Page Provider received an unsupported attachment.");
    }
    const bytes = Buffer.from(data, "base64");
    if (!data || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("Each Page Provider image must be between 1 byte and 10 MiB.");
    }
    totalBytes += bytes.byteLength;
    return { mimeType, bytes };
  });
  if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
    throw new Error("Page Provider images may total at most 80 MiB per turn.");
  }
  if (!text && normalizedAttachments.length === 0) {
    throw new Error("Page Provider request has no text or image.");
  }
  return {
    id: String(request.id ?? ""),
    method,
    text,
    mode,
    site,
    dedupe: request?.params?.dedupe === true,
    deliveryContract,
    newConversation,
    conversationId,
    attachments: normalizedAttachments,
  };
}

function extensionForMimeType(mimeType) {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  }[mimeType];
}

async function materializeImages(attachments) {
  if (!attachments?.length) return { paths: [], cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "pi-page-provider-"));
  try {
    const paths = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const suffix = String(index + 1).padStart(2, "0");
      const path = join(directory, `attachment-${suffix}.${extensionForMimeType(attachment.mimeType)}`);
      await writeFile(path, attachment.bytes, { mode: 0o600 });
      paths.push(path);
    }
    return {
      paths,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function responseRow(result) {
  const rows = Array.isArray(result) ? result : [result];
  return rows.at(-1);
}

function responseMarkdown(result) {
  const row = responseRow(result);
  if (typeof row === "string") return row;
  if (!row || typeof row !== "object") return "";
  for (const key of ["response", "content", "text", "value"]) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key];
  }
  return "";
}

function responseRemote(result, site, mode) {
  const remote = { site, mode };
  const row = responseRow(result);
  if (!row || typeof row !== "object") return remote;

  const conversationId = String(row.conversationId ?? "").trim();
  const conversationUrl = String(row.conversationUrl ?? "").trim();
  if (conversationId && conversationId.length <= 256 && /^[a-z0-9_-]+$/i.test(conversationId)) {
    remote.conversationId = conversationId;
  }
  if (conversationUrl && conversationUrl.length <= 2048) {
    try {
      const url = new URL(conversationUrl);
      const allowed =
        site === "deepseek"
          ? url.hostname === "chat.deepseek.com"
          : site === "chatgpt"
            ? url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")
            : url.hostname === "gemini.google.com";
      if (url.protocol === "https:" && allowed) remote.conversationUrl = url.href;
    } catch {
      // Do not expose malformed or off-site adapter URLs to PI.
    }
  }
  return remote;
}

let turnFailureStage = "setup";
let remoteConversationObserved = false;

function publicError(error) {
  const rawCode = typeof error?.code === "string" ? error.code : "OPENCLI_ERROR";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const evidence = `${rawCode} ${rawMessage}`;
  if (/auth|login|sign[ -]?in|logged[ -]?in/i.test(evidence)) {
    return {
      code: "LOGIN_REQUIRED",
      message: "The selected web model page requires an authenticated browser session.",
      recoverable: true,
    };
  }
  if (/not installed|not available on path|could not resolve/i.test(evidence)) {
    return {
      code: "OPENCLI_UNAVAILABLE",
      message: "OpenCLI is not installed or is not available to PI-Desktop.",
      recoverable: true,
    };
  }
  const timedOut = /timeout|timed out/i.test(evidence);
  if (turnFailureStage === "extraction") {
    return {
      code: "PAGE_PROVIDER_EXTRACTION_FAILED",
      message: "The web turn completed, but its assistant response could not be extracted.",
      recoverable: true,
    };
  }
  if (turnFailureStage === "completion" || remoteConversationObserved) {
    return {
      code: timedOut ? "PAGE_PROVIDER_COMPLETION_TIMEOUT" : "PAGE_PROVIDER_COMPLETION_FAILED",
      message: timedOut
        ? "The remote conversation was discovered, but its reply did not complete before the timeout."
        : "The remote conversation was discovered, but reply completion failed.",
      recoverable: true,
    };
  }
  if (turnFailureStage === "send") {
    const discoveryFailure = timedOut || /conversation|remote|url/i.test(evidence);
    return {
      code: discoveryFailure ? "PAGE_PROVIDER_CONVERSATION_DISCOVERY_FAILED" : "PAGE_PROVIDER_SEND_FAILED",
      message: discoveryFailure
        ? "The web request may have been sent, but its remote conversation could not be verified."
        : "The request could not be sent to the web model page.",
      recoverable: true,
    };
  }
  return {
    code: rawCode,
    message: "OpenCLI could not complete the page-provider turn.",
    recoverable: true,
  };
}

async function main() {
  if (!process.argv.includes("--stdio")) {
    throw new Error("This bridge must be started with --stdio.");
  }

  const request = await readRequest();
  const site = request.site;
  const timeout = Number.parseInt(String(process.env.PI_PAGE_PROVIDER_TIMEOUT ?? "120"), 10);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) {
    throw new Error("PI_PAGE_PROVIDER_TIMEOUT must be an integer from 1 to 3600 seconds.");
  }

  emit({ type: "provider.state", state: "attaching", provider: { site } });
  const root = await resolveOpenCliRoot();
  const executionPath = join(root, "dist", "src", "execution.js");
  const adapterName =
    request.method === "provider.probe"
      ? "status"
      : request.method === "provider.open"
        ? "detail"
        : request.method === "provider.new"
          ? "new"
          : "ask";
  const packagedAdapterPath = join(root, "clis", site, `${adapterName}.js`);
  const userAdapterPath = join(homedir(), ".opencli", "clis", site, `${adapterName}.js`);
  let adapterPath = packagedAdapterPath;
  const candidateRoot = String(process.env.PI_PAGE_PROVIDER_ADAPTER_ROOT ?? "").trim();
  if (candidateRoot && request.deliveryContract === WEB_CONTRACT) {
    // Explicit candidate path; missing/incompatible files must NOT fall back to installed code.
    adapterPath = join(resolve(candidateRoot), site, `${adapterName}.js`);
  } else if (adapterName === "ask" && ["chatgpt", "deepseek"].includes(site)) {
    const builtin = await prepareBuiltinAdapter(root, site);
    adapterPath = builtin.adapterPath;
    cleanupAdapter = builtin.cleanup;
  } else {
    try {
      await access(userAdapterPath, fsConstants.R_OK);
      adapterPath = userAdapterPath;
    } catch {
      // Legacy default only; strict capability check below still refuses old adapters.
    }
  }
  await access(executionPath, fsConstants.R_OK);
  await access(adapterPath, fsConstants.R_OK);

  const [{ executeCommand }, adapter] = await Promise.all([
    import(pathToFileURL(executionPath).href),
    import(pathToFileURL(adapterPath).href),
  ]);
  const command =
    request.method === "provider.probe"
      ? adapter?.statusCommand
      : request.method === "provider.open"
        ? adapter?.detailCommand
        : request.method === "provider.new"
          ? adapter?.newCommand
          : adapter?.askCommand;
  if (typeof executeCommand !== "function" || !command) {
    throw new Error(`Installed OpenCLI does not expose a compatible ${site} ${adapterName} adapter.`);
  }

  if (request.method === "provider.probe") {
    const statusResult = await executeCommand(command, {}, false, { siteSession: "persistent" });
    const row = Array.isArray(statusResult) ? statusResult.at(-1) : statusResult;
    const login = String(row?.Login ?? "").toLowerCase() === "yes";
    const connected = String(row?.Status ?? "").toLowerCase() === "connected";
    const state = !login ? "loginRequired" : connected ? "ready" : "interrupted";
    emit({
      type: "provider.state",
      state,
      provider: { site, url: String(row?.Url ?? ""), authenticated: login },
    });
    emit({ type: "provider.probed", id: request.id, state });
    return;
  }

  if (request.method === "provider.open") {
    await executeCommand(command, { id: request.conversationId }, false, { siteSession: "persistent" });
    emit({ type: "provider.state", state: "ready", provider: { site } });
    emit({
      type: "provider.opened",
      id: request.id,
      provider: { site, conversationId: request.conversationId },
    });
    return;
  }

  if (request.method === "provider.new") {
    await executeCommand(command, {}, false, { siteSession: "persistent" });
    emit({ type: "provider.state", state: "ready", provider: { site } });
    emit({ type: "provider.started", id: request.id, provider: { site } });
    return;
  }

  const strict = request.deliveryContract === WEB_CONTRACT;
  if (strict && command.pageProviderDispatchContract !== WEB_CONTRACT)
    throw new Error("Installed site adapter lacks the gated dispatch/receipt contract; no fallback.");
  let permitted = false;
  let evidence;
  const beforeSubmit = async (actualText) => {
    if (permitted || actualText !== request.text) throw new Error("Web composer text changed or duplicate submit.");
    emit({ type: "turn.dispatch_ready", turnId: request.id, request: rawRequest });
    const frame = await frames.next();
    if (frame.done) throw new Error("Web dispatch was not approved.");
    const permit = JSON.parse(frame.value);
    if (permit.id !== request.id || permit.method !== "turn.dispatch" || permit.promptHash !== hashText(request.text))
      throw new Error("Invalid Web dispatch approval.");
    permitted = true;
  };
  const releaseSiteLock = await acquireSiteLock(site);
  try {
    emit({ type: "provider.state", state: "ready", provider: { site } });
    emit({ type: "turn.status", status: "sending", turnId: request.id });
    const images = await materializeImages(request.attachments);
    try {
      turnFailureStage = "send";
      const result = await executeCommand(
        command,
        {
          prompt: request.text,
          timeout,
          ...(strict
            ? {
                beforeSubmit,
                onDelivery: (value) => {
                  evidence = value;
                },
              }
            : {}),
          onConversation: async (conversation) => {
            const remote = responseRemote([conversation], site, request.mode);
            if (remote.conversationId && remote.conversationUrl) {
              remoteConversationObserved = true;
              turnFailureStage = "completion";
              emit({ type: "turn.remote", turnId: request.id, remote });
            }
          },
          ...(request.newConversation ? { new: true } : {}),
          ...(request.conversationId ? { conversation: request.conversationId } : {}),
          ...(site === "deepseek" ? { think: request.mode === "reasoner" } : {}),
          ...(request.dedupe || request.text.startsWith("[PI TASK HANDOFF]") ? { dedupe: true } : {}),
          ...(images.paths.length > 0 ? { file: images.paths.length === 1 ? images.paths[0] : images.paths } : {}),
        },
        false,
        { siteSession: "persistent" },
      );

      turnFailureStage = "extraction";
      const markdown = responseMarkdown(result);
      if (!markdown) throw new Error("OpenCLI completed without an assistant response.");
      const remote = responseRemote(result, site, request.mode);
      if (
        strict &&
        (!permitted ||
          evidence?.promptHash !== hashText(request.text) ||
          evidence?.responseHash !== hashText(markdown) ||
          evidence?.evidence !== "adapter-exact-prompt-pair" ||
          !remote.conversationId ||
          !remote.conversationUrl)
      )
        throw new Error("Web reply could not be paired with the exact approved input.");
      emit({
        type: "turn.completed",
        turnId: request.id,
        message: { markdown },
        remote,
        ...(strict
          ? {
              receipt: {
                schema: WEB_CONTRACT,
                turnId: request.id,
                promptHash: evidence.promptHash,
                responseHash: evidence.responseHash,
                evidence: evidence.evidence,
                remote,
              },
            }
          : {}),
      });
    } finally {
      await images.cleanup();
    }
  } finally {
    await releaseSiteLock();
  }
}

main()
  .catch((error) => {
    const normalized = publicError(error);
    fail(normalized.code, normalized.message, normalized.recoverable);
  })
  .finally(() => cleanupAdapter());
