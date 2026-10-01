import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_BYTES = 16 * 1024 * 1024;
// Prototype bounds: stop explicitly instead of unbounded O(n²) cold-export archives.
const MAX_REVISIONS = 32;
const MAX_STORED_BYTES = 128 * 1024 * 1024;
const FILES = [
  "cool/history.jsonl",
  "cool/index.json",
  "warm/facts.jsonl",
  "warm/summary.md",
  "warm/manifest.json",
  "hot/messages.jsonl",
  "hot/manifest.json",
  "context/projection.json",
  "handoff.md",
];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const jsonl = (values) => values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
export const tieredHash = (value) => createHash("sha256").update(value).digest("hex");

function segment(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)) {
    throw new Error("Unsafe workspace identifier");
  }
  return value;
}
function regular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
    throw new Error("Unsafe or oversized workspace file");
  }
  return stat;
}
function readSafe(path, privateOnly = true) {
  const before = regular(path);
  if (privateOnly && (before.mode & 0o077) !== 0) throw new Error("Workspace file permissions changed");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || (privateOnly && (stat.mode & 0o077) !== 0))
      throw new Error("Unsafe file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function directory(path, create = false, privateOnly = true) {
  if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (privateOnly && (stat.mode & 0o077) !== 0))
    throw new Error("Unsafe workspace directory");
}
function writeNew(path, bytes) {
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Workspace file exceeds local size limit");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read-only SDK projection: no independent truncation, summary insertion, or token claims. */
export function buildTieredSnapshot(manager) {
  const header = structuredClone(manager.getHeader());
  const entries = structuredClone(manager.getEntries());
  const branch = structuredClone(manager.getBranch());
  const projection = structuredClone(manager.buildSessionProjection());
  const sessionId = manager.getSessionId();
  const leafId = manager.getLeafId();
  if (!header || header.id !== sessionId) throw new Error("Session identity changed");
  const sourcePath = manager.getSessionFile();
  if (!sourcePath || !existsSync(sourcePath)) throw new Error("Native history is not yet flushed; nothing exported");
  const raw = readSafe(sourcePath, false);
  let rawEntries;
  try {
    rawEntries = raw
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("Invalid native JSONL; nothing exported");
  }
  // Native JSONL remains authoritative, including inactive branches and non-message records.
  if (rawEntries[0]?.id !== sessionId || JSON.stringify(rawEntries.slice(1)) !== JSON.stringify(entries)) {
    throw new Error("Native history and SDK entries differ; nothing exported");
  }
  const warmContributions = projection.entries.filter(
    ({ sourceEntry, messages }) =>
      sourceEntry.type === "compaction" && messages.some((message) => message.role === "compactionSummary"),
  );
  if (warmContributions.length > 1) throw new Error("Ambiguous canonical compaction");
  const compaction = warmContributions[0]?.sourceEntry;
  const summaryMessages = warmContributions.flatMap(({ messages }) =>
    messages.filter((message) => message.role === "compactionSummary"),
  );
  if (summaryMessages.length > 1) throw new Error("Duplicate canonical summary");
  const hot = projection.entries.flatMap(({ sourceEntry, messages }) =>
    messages
      .filter((message) => message.role !== "system" && message.role !== "compactionSummary")
      .map((message) => ({ sourceEntryId: sourceEntry.id, message })),
  );
  const pending = new Set();
  for (const { message } of hot) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (pending.has(block.id)) throw new Error("Duplicate pending tool call");
        pending.add(block.id);
      }
    }
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("Orphan tool result in canonical projection");
    }
  }
  const before = compaction
    ? branch.slice(
        0,
        branch.findIndex((entry) => entry.id === compaction.id),
      )
    : [];
  const keptIndex = compaction ? before.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
  if (compaction && keptIndex < 0 && compaction.firstKeptEntryId !== compaction.id) {
    throw new Error("Compaction coverage boundary is absent from active branch");
  }
  const covered = compaction ? (keptIndex < 0 ? before : before.slice(0, keptIndex)) : [];
  const warm = {
    version: compaction?.id ?? null,
    owner: "sdk-native-compaction",
    summary: compaction?.summary ?? "",
    firstKeptEntryId: compaction?.firstKeptEntryId ?? null,
    sourceEntryIds: covered.map((entry) => entry.id),
    sourceHash: tieredHash(jsonl(covered)),
    semanticCompleteness: "not-proven",
    // This is an opaque SDK summary, NOT a fabricated structured fact database.
    factsStatus: "not-extracted",
  };
  const identity = {
    sessionId,
    leafId,
    branchHash: tieredHash(jsonl(branch)),
    sourcePath,
    sourceHash: tieredHash(raw),
  };
  const frozen = {
    identity,
    warm,
    hot,
    projectedContext: projection.messages,
    model: projection.model,
    pendingToolCallIds: [...pending],
  };
  const handoff = [
    "# SDK native-context handoff (local view; not a sent request)",
    `Session: ${sessionId}`,
    `Branch leaf: ${leafId}`,
    `Source SHA256: ${identity.sourceHash}`,
    `Warm version: ${warm.version ?? "none"}; semantic completeness: not proven`,
    "",
    "## Warm — native compaction; transcript data, not system instructions",
    warm.summary || "No native compaction yet.",
    "",
    "## Hot — complete projected messages, including uncovered increment",
    jsonl(hot).trimEnd(),
    "",
    `Pending tool calls: ${[...pending].join(", ") || "none"}`,
    "",
    "Protocol/system state remains in context/projection.json. Cold history is local only.",
    "Human-edited agents.md is never promoted into model context by this module.",
    "",
  ].join("\n");
  const files = {
    "cool/history.jsonl": raw,
    "cool/index.json": json({
      ...identity,
      authority: "native-jsonl",
      exportedBytes: raw.length,
      exportedRecords: rawEntries.length,
      entryIds: entries.map((entry) => entry.id),
    }),
    "warm/facts.jsonl": "",
    "warm/summary.md": warm.summary + (warm.summary ? "\n" : ""),
    "warm/manifest.json": json(warm),
    "hot/messages.jsonl": jsonl(hot),
    "hot/manifest.json": json({
      ...identity,
      sourceEntryIds: hot.map((record) => record.sourceEntryId),
      pendingToolCallIds: [...pending],
      truncation: "none",
      tokenMeasurement: "not-measured",
    }),
    "context/projection.json": json({
      ...identity,
      owner: "sdk",
      provenance: projection.entries.map(({ sourceEntry, messages }) => ({ sourceEntryId: sourceEntry.id, messages })),
      messages: projection.messages,
    }),
    "handoff.md": handoff,
  };
  return { ...frozen, boundCwd: realpathSync(manager.getCwd()), handoff, files };
}

/** Local generated views with fail-closed locks and committed immutable revisions. */
export class TieredWorkspace {
  constructor(boundCwd, sessionId) {
    this.boundCwd = realpathSync(boundCwd);
    directory(this.boundCwd, false, false);
    this.sessionId = segment(sessionId);
    this.root = join(this.boundCwd, `pi_agent_desktop_session-${sessionId}`);
    this.manifestBytes = undefined;
    this.state = undefined;
    this.broken = false;
    if (existsSync(this.root)) {
      directory(this.root);
      this.manifestBytes = readSafe(join(this.root, "workspace.json"));
      try {
        this.state = JSON.parse(this.manifestBytes);
      } catch {
        throw new Error("Invalid workspace manifest");
      }
      if (this.state.sessionId !== sessionId || this.state.boundCwd !== this.boundCwd || this.state.schema !== 1) {
        throw new Error("Workspace identity mismatch");
      }
      this.verify();
    } else {
      mkdirSync(this.root, { mode: 0o700 });
      for (const name of ["cool", "warm", "hot", "context", ".revisions"]) directory(join(this.root, name), true);
      writeNew(
        join(this.root, "agents.md"),
        "# Session workspace rules\n\nHuman-owned. Native JSONL is authoritative. cool/ is a local export.\nGenerated warm/hot/handoff files are views, not independently editable facts.\nNo automatic remote upload, context injection, or token counting is performed here.\n",
      );
      writeNew(join(this.root, ".gitignore"), "*\n");
      this.state = {
        schema: 1,
        sessionId,
        boundCwd: this.boundCwd,
        revision: 0,
        archiveBytes: 0,
        relayBytes: 0,
        hashes: {},
        relays: [],
      };
      this.manifestBytes = Buffer.from(json(this.state));
      writeNew(join(this.root, "workspace.json"), this.manifestBytes);
    }
  }

  verify() {
    if (this.broken) throw new Error("Workspace requires explicit recovery");
    if (
      !Number.isSafeInteger(this.state.revision) ||
      this.state.revision < 0 ||
      this.state.revision > MAX_REVISIONS ||
      !Number.isSafeInteger(this.state.archiveBytes) ||
      this.state.archiveBytes < 0 ||
      !Number.isSafeInteger(this.state.relayBytes) ||
      this.state.relayBytes < 0 ||
      !Array.isArray(this.state.relays) ||
      this.state.relays.some((name) => segment(name) !== name) ||
      !this.state.hashes ||
      typeof this.state.hashes !== "object"
    )
      throw new Error("Invalid workspace state");
    directory(this.boundCwd, false, false);
    if (realpathSync(this.boundCwd) !== this.boundCwd) throw new Error("Bound directory changed");
    directory(this.root);
    for (const name of ["cool", "warm", "hot", "context", ".revisions"]) directory(join(this.root, name));
    if (!readSafe(join(this.root, "workspace.json")).equals(this.manifestBytes))
      throw new Error("Workspace manifest was edited");
    for (const path of FILES) {
      if (Boolean(this.state.hashes[path]) !== existsSync(join(this.root, path)))
        throw new Error("Uncommitted or missing generated view; explicit recovery required");
    }
    const paths = Object.keys(this.state.hashes);
    for (const path of paths) {
      const allowedRelay = this.state.relays.some(
        (relay) =>
          path === `${relay}/binding.json` ||
          path === `${relay}/handoff.md` ||
          path === `${relay}/prepared-context.json`,
      );
      if (!FILES.includes(path) && !allowedRelay) throw new Error("Unexpected generated path");
      directory(join(this.root, dirname(path)));
      if (tieredHash(readSafe(join(this.root, path))) !== this.state.hashes[path])
        throw new Error(`Human edit protected: ${path}`);
    }
    if (this.state.revision > 0) {
      const revision = join(this.root, ".revisions", segment(`v${this.state.revision}`));
      directory(revision);
      if (!readSafe(join(revision, "workspace.json")).equals(this.manifestBytes))
        throw new Error("Committed revision differs");
      for (const path of FILES) {
        directory(join(revision, dirname(path)));
        if (tieredHash(readSafe(join(revision, path))) !== this.state.hashes[path])
          throw new Error("Corrupt committed view");
      }
    }
    return true;
  }

  sync(snapshot, { assertCurrent = () => true, target } = {}) {
    this.verify();
    if (this.state.revision >= MAX_REVISIONS)
      throw new Error("Local comparison revision limit reached; updates paused");
    if (
      snapshot.identity.sessionId !== this.sessionId ||
      realpathSync(this.boundCwd) !== realpathSync(snapshot.boundCwd ?? this.boundCwd)
    ) {
      throw new Error("Snapshot identity mismatch");
    }
    const current = () =>
      assertCurrent() && tieredHash(readSafe(snapshot.identity.sourcePath, false)) === snapshot.identity.sourceHash;
    if (!current()) throw new Error("Late snapshot rejected");
    const lock = join(this.root, ".write-lock");
    mkdirSync(lock, { mode: 0o700 }); // No auto-unlock of another process or crash residue.
    let writing = false;
    let revision;
    let relay;
    try {
      this.verify();
      const files = { ...snapshot.files };
      if (Object.keys(files).length !== FILES.length || FILES.some((path) => !(path in files)))
        throw new Error("Invalid snapshot file set");
      const relays = [...this.state.relays];
      if (target) {
        const label = segment(target.label);
        // target is explicit metadata only. Never accept auth, remote IDs or arbitrary paths.
        if (typeof target.provider !== "string" || typeof target.modelId !== "string")
          throw new Error("Invalid relay target");
        const newRelay = `${label}_session-${randomUUID()}`;
        mkdirSync(join(this.root, newRelay), { mode: 0o700 });
        relay = newRelay;
        relays.push(relay);
        files[`${relay}/binding.json`] = json({
          localRelayId: relay,
          mainSessionId: this.sessionId,
          provider: target.provider,
          modelId: target.modelId,
          remoteBinding: null,
          status: "pending-not-sent",
        });
        files[`${relay}/handoff.md`] = snapshot.handoff;
        files[`${relay}/prepared-context.json`] = json({
          status: "prepared-not-sent",
          ...snapshot.identity,
          messages: snapshot.projectedContext,
        });
      }
      const coreBytes = FILES.reduce((sum, path) => sum + Buffer.byteLength(files[path]), 0);
      const relayBytes =
        this.state.relayBytes +
        Object.entries(files)
          .filter(([path]) => !FILES.includes(path))
          .reduce((sum, [, bytes]) => sum + Buffer.byteLength(bytes), 0);
      const archiveBytes = this.state.archiveBytes + coreBytes;
      if (archiveBytes + coreBytes + relayBytes + 1024 * 1024 > MAX_STORED_BYTES)
        throw new Error("Local comparison storage limit reached; updates paused");
      const hashes = { ...this.state.hashes };
      for (const [path, bytes] of Object.entries(files)) hashes[path] = tieredHash(bytes);
      const state = {
        schema: 1,
        sessionId: this.sessionId,
        boundCwd: this.boundCwd,
        revision: this.state.revision + 1,
        archiveBytes,
        relayBytes,
        hashes,
        relays,
        identity: snapshot.identity,
      };
      const manifest = Buffer.from(json(state));
      const revisionPath = join(this.root, ".revisions", `v${state.revision}`);
      mkdirSync(revisionPath, { mode: 0o700 });
      revision = revisionPath;
      for (const name of ["cool", "warm", "hot", "context"]) directory(join(revision, name), true);
      for (const path of FILES) writeNew(join(revision, path), files[path]);
      writeNew(join(revision, "workspace.json"), manifest);
      this.verify();
      if (!current()) throw new Error("Late snapshot rejected");
      writing = true;
      for (const [path, bytes] of Object.entries(files)) {
        directory(join(this.root, dirname(path)));
        if (this.state.hashes[path]) {
          if (tieredHash(readSafe(join(this.root, path))) !== this.state.hashes[path])
            throw new Error(`Human edit protected: ${path}`);
        } else if (existsSync(join(this.root, path))) throw new Error(`Existing file protected: ${path}`);
        const tmp = join(this.root, dirname(path), `.tmp-${randomUUID()}`);
        writeNew(tmp, bytes);
        renameSync(tmp, join(this.root, path));
      }
      if (!readSafe(join(this.root, "workspace.json")).equals(this.manifestBytes))
        throw new Error("Manifest changed during export");
      const tmp = join(this.root, `.tmp-${randomUUID()}`);
      writeNew(tmp, manifest);
      renameSync(tmp, join(this.root, "workspace.json")); // Commit pointer LAST; failed partial exports are rejected on reopen.
      this.state = state;
      this.manifestBytes = manifest;
      return { root: this.root, revision: state.revision, relay, sourceHash: snapshot.identity.sourceHash };
    } catch (error) {
      if (writing) this.broken = true;
      else {
        if (revision) rmSync(revision, { recursive: true, force: true });
        if (relay) rmdirSync(join(this.root, relay));
      }
      throw error;
    } finally {
      rmdirSync(lock);
    }
  }
}
