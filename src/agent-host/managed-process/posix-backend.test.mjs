import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";
import test from "node:test";
import { PosixManagedProcessBackend } from "./posix-backend.ts";

class FakeWorker extends EventEmitter {
  pid = 41_234;
  stdout = new PassThrough();
  stderr = new PassThrough();
  connected = true;
  exitCode = null;
  signalCode = null;
  sent = [];

  send(message) {
    this.sent.push(message);
    if (message.type === "bootstrap") {
      setImmediate(() =>
        this.emit("message", {
          type: "prepared",
          processId: message.processId,
          runId: message.runId,
          nonce: message.nonce,
        }),
      );
    }
    if (message.type === "commit") {
      setImmediate(() => this.emit("message", { type: "started", shellPid: this.pid + 1 }));
    }
    if (message.type === "stop") {
      setImmediate(() => this.close(0));
    }
    return true;
  }

  close(code = 0, signal = null) {
    if (!this.connected) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function launchInput() {
  return {
    processId: "proc-test",
    runId: "run-test",
    cwd: "/workspace",
    command: "npm run dev",
    shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
    context: {
      inventoryRevision: 1,
      resolutionId: "test",
      nativeEnv: {},
      shellEnv: { PATH: "/usr/bin", SECRET: "kept-in-child-only" },
      commands: {},
      summary: [],
    },
  };
}

test("POSIX backend implements prepare, commit, I/O, stop, and verified group cleanup", async () => {
  const worker = new FakeWorker();
  let spawnArguments;
  const cleanedGroups = [];
  const events = [];
  const backend = new PosixManagedProcessBackend({
    platform: "linux",
    workerEntryPath: "/app/managed-process-worker.mjs",
    workerExecArgv: ["--worker-flag"],
    hostInstanceId: "host-test",
    spawnProcess: (...args) => {
      spawnArguments = args;
      return worker;
    },
    fingerprint: async (pid) => `fingerprint-${pid}`,
    terminateProcessGroup: async (pgid, options) => {
      cleanedGroups.push({ pgid, options });
      return true;
    },
    now: () => 1_234,
  });
  backend.onEvent((event) => events.push(event));

  const prepared = await backend.prepare(launchInput());
  assert.equal(spawnArguments[0], process.execPath);
  assert.deepEqual(spawnArguments[1], ["--worker-flag", "/app/managed-process-worker.mjs"]);
  assert.equal(spawnArguments[2].detached, true);
  assert.equal(spawnArguments[2].env.SECRET, "kept-in-child-only");
  assert.equal(spawnArguments[2].env.PI_DESKTOP_MANAGED_PROCESS_ID, "proc-test");
  assert.equal(worker.sent[0].type, "bootstrap");
  assert.equal(worker.sent[0].command, "npm run dev");
  assert.deepEqual(prepared.reaper, {
    version: 2,
    platform: "posix",
    processId: "proc-test",
    runId: "run-test",
    hostInstanceId: "host-test",
    pid: worker.pid,
    pgid: worker.pid,
    startFingerprint: `fingerprint-${worker.pid}`,
    nonce: prepared.reaper.nonce,
    createdAt: 1_234,
  });
  await assert.rejects(backend.commit(prepared, 0), /Invalid POSIX prepared containment/);
  assert.equal(worker.sent.filter((message) => message.type === "commit").length, 0);
  assert.throws(() => backend.write({ text: "early", appendNewline: false, close: false }), /not committed/);
  await backend.commit(prepared, 7);
  assert.deepEqual(worker.sent.at(-1), {
    type: "commit",
    processId: "proc-test",
    runId: "run-test",
    nonce: prepared.reaper.nonce,
    journalRevision: 7,
  });
  await assert.rejects(backend.commit(prepared, 7), /Invalid POSIX/);

  worker.stdout.write("ready\n");
  backend.write({ text: "hello", appendNewline: true, close: false });
  await backend.stop("graceful", "user");
  assert.deepEqual(worker.sent.slice(-2), [
    { type: "stdin", text: "hello", appendNewline: true, close: false },
    { type: "stop", mode: "graceful", source: "user" },
  ]);
  worker.emit("message", { type: "exit", code: 0 });
  worker.close(0);
  await backend.waitForExit();

  assert.equal(
    events.some((event) => event.type === "stdout" && event.bytes.toString() === "ready\n"),
    true,
  );
  assert.deepEqual(cleanedGroups, [
    {
      pgid: worker.pid,
      options: { interruptMs: 250, terminateMs: 750, forceMs: 1_000 },
    },
  ]);
  assert.deepEqual(events.at(-1), { type: "exit", exit: { code: 0, reason: "stopped" } });
});

test("POSIX backend reports host-failure and retains uncertainty when group cleanup is unverified", async () => {
  const worker = new FakeWorker();
  const events = [];
  const backend = new PosixManagedProcessBackend({
    platform: "darwin",
    workerEntryPath: "/app/managed-process-worker.mjs",
    hostInstanceId: "host-test",
    spawnProcess: () => worker,
    fingerprint: async () => "fingerprint",
    terminateProcessGroup: async () => false,
  });
  backend.onEvent((event) => events.push(event));
  await backend.prepare(launchInput());
  worker.close(9, "SIGKILL");
  await backend.waitForExit();
  assert.deepEqual(events.at(-1), {
    type: "exit",
    exit: { code: 9, signal: "SIGKILL", reason: "host-failure" },
  });
});

for (const scenario of ["missing-fingerprint", "cancel-during-fingerprint", "stop-before-commit"]) {
  test(`POSIX prepare cannot authorize effects: ${scenario}`, async () => {
    const worker = new FakeWorker();
    const controller = new globalThis.AbortController();
    const backend = new PosixManagedProcessBackend({
      platform: "darwin",
      workerEntryPath: "/app/managed-process-worker.mjs",
      hostInstanceId: "host-test",
      spawnProcess: () => worker,
      fingerprint: async () => {
        if (scenario === "cancel-during-fingerprint") controller.abort();
        return scenario === "missing-fingerprint" ? null : "fictional-fingerprint";
      },
      terminateProcessGroup: async () => true,
    });
    if (scenario === "stop-before-commit") {
      const prepared = await backend.prepare(launchInput(), controller.signal);
      await backend.stop("force", "user");
      await assert.rejects(backend.commit(prepared, 1), /Invalid POSIX/);
      await backend.waitForExit();
    } else {
      await assert.rejects(backend.prepare(launchInput(), controller.signal), /identity|live owner/);
    }
    assert.equal(
      worker.sent.some((message) => message.type === "commit"),
      false,
    );
    assert.equal(worker.connected, false);
  });
}
