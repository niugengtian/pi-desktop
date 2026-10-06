import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createManagedBashOperations } from "./bash.ts";
import { managedBashFixture } from "./fixtures/bash.mjs";

async function directory(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-bash-fictional-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("native Bash preserves pinned shell/environment and raw bytes, and waits for recovery cleanup", async (t) => {
  const cwd = await directory(t);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const unregistering = new Promise((resolve) => {
    entered = resolve;
  });
  const bytes = Buffer.from([0, 255, 10, 65]);
  const f = managedBashFixture({
    onCommit(backend) {
      backend.emit({ type: "stdout", bytes });
      backend.emit({ type: "stderr", bytes: Buffer.from("error without newline") });
      backend.end({ code: 7, reason: "exit" });
    },
    unregister: async () => {
      entered();
      await gate;
    },
  });
  const chunks = [];
  let completed = false;
  const execution = createManagedBashOperations(f.service, "native-owner", cwd, true, f.context)
    .exec("fictional command", cwd, {
      onData: (chunk) => chunks.push(chunk),
      env: { PATH: "/pinned/bin", SDK_CONTEXT: "retained", API_KEY: "fictional-secret" },
    })
    .then((result) => {
      completed = true;
      return result;
    });
  try {
    await unregistering;
    assert.equal(completed, false);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([bytes, Buffer.from("error without newline")]));
    const backend = f.backends[0];
    assert.equal(backend.input.context.resolutionId, f.context.resolutionId);
    assert.equal(backend.input.shell.executable, "/fixture/bash");
    assert.deepEqual(backend.input.context.shellEnv, { PATH: "/pinned/bin", SDK_CONTEXT: "retained" });
    assert.deepEqual(backend.writes, [{ text: "", appendNewline: false, close: true }]);
    assert.equal(f.context.shellEnv.PATH, "/fixture/bin:/usr/bin");
    release();
    assert.deepEqual(await execution, { exitCode: 7 });
    const info = f.service.list(true, "native-owner").processes[0];
    await assert.rejects(f.service.restart(info.processId, info.runId, "user"), /owning task operation/);
    assert.throws(
      () => f.service.write({ processId: info.processId, runId: info.runId, text: "late" }),
      /interactive input/,
    );
  } finally {
    release();
    await execution.catch(() => undefined);
  }
});

test("native Bash streams beyond the panel buffer and retains shell signal exit status", async (t) => {
  const cwd = await directory(t);
  const chunk = Buffer.alloc(1024 * 1024, 120);
  let bytes = 0;
  const f = managedBashFixture({
    onCommit(backend) {
      for (let index = 0; index < 3; index++) backend.emit({ type: "stdout", bytes: chunk });
      backend.end({ code: null, signal: "SIGTERM", reason: "exit" });
    },
  });
  const result = await createManagedBashOperations(f.service, "output-owner", cwd, true, f.context).exec(
    "fictional",
    cwd,
    {
      onData(data) {
        bytes += data.length;
      },
    },
  );
  assert.equal(bytes, 3 * chunk.length);
  assert.equal(result.exitCode, 143);
  assert.ok(f.service.list(true, "output-owner").processes[0].output.retainedBytes < bytes);
});

for (const scenario of ["abort", "timeout", "output-error", "output-dropped", "host-failure", "unregister-error"]) {
  test(`native Bash does not accept incomplete execution: ${scenario}`, async (t) => {
    const cwd = await directory(t);
    const controller = new globalThis.AbortController();
    const f = managedBashFixture({
      onCommit(backend) {
        if (scenario === "abort") controller.abort();
        if (scenario === "output-error") backend.emit({ type: "stdout", bytes: Buffer.from("fixture") });
        if (scenario === "output-dropped") backend.emit({ type: "output-dropped", bytes: 7, chunks: 1 });
        if (scenario === "host-failure") backend.end({ code: null, reason: "host-failure" });
        if (scenario === "unregister-error") backend.end({ code: 0, reason: "exit" });
      },
      unregister: async () => {
        if (scenario === "unregister-error") throw new Error("fictional reaper unavailable");
      },
    });
    const operation = createManagedBashOperations(f.service, `owner-${scenario}`, cwd, true, f.context);
    const keepAlive = delay(200);
    await assert.rejects(
      operation.exec("fictional", cwd, {
        signal: controller.signal,
        timeout: scenario === "timeout" ? 0.02 : undefined,
        onData() {
          if (scenario === "output-error") throw new Error("Output consumer failed");
        },
      }),
      /aborted|timeout:|Output consumer failed|output was dropped|cleanup is not verified/,
    );
    assert.equal(f.backends[0].ended, true);
    await keepAlive;
  });
}

test("native Bash keeps trust, feature, command and timeout gates before target dispatch", async (t) => {
  const cwd = await directory(t);
  for (const scenario of ["trust", "disabled", "command", "timeout"]) {
    const f = managedBashFixture({ enabled: scenario !== "disabled" });
    const operation = createManagedBashOperations(f.service, "gated-owner", cwd, scenario !== "trust", f.context);
    await assert.rejects(
      operation.exec(scenario === "command" ? "nohup fictional" : "fictional", cwd, {
        onData() {},
        timeout: scenario === "timeout" ? -1 : undefined,
      }),
    );
    assert.equal(f.backends.length, 0);
  }
});

test("waiting for process capacity does not consume the native command execution timeout", async (t) => {
  const cwd = await directory(t);
  const f = managedBashFixture({
    onCommit(backend) {
      if (backend.input.command === "queued") backend.end();
    },
  });
  t.after(() => f.service.stopAll("host"));
  const occupied = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.service.startForAgent(
        "capacity-owner",
        cwd,
        true,
        { command: "occupied", waitFor: { type: "none" } },
        undefined,
        { context: f.context, onEvent() {} },
      ),
    ),
  );
  let waiting,
    finished = false;
  const queued = new Promise((resolve) => {
    waiting = resolve;
  });
  const pending = createManagedBashOperations(f.service, "capacity-owner", cwd, true, f.context)
    .exec("queued", cwd, { onData() {}, timeout: 0.01, onAdmission: waiting })
    .then((result) => {
      finished = true;
      return result;
    });
  void pending.catch(() => undefined);
  await queued;
  await delay(30);
  assert.equal(finished, false);
  assert.equal(f.backends.length, 4);
  await f.service.stop(occupied[0].process.processId, occupied[0].runId, "force", "host");
  assert.deepEqual(await pending, { exitCode: 0 });
  assert.equal(f.backends.length, 5);
});
