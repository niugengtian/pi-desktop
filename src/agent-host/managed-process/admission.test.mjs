import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedProcessAdmission } from "./admission.ts";
import { managedBashFixture } from "./fixtures/bash.mjs";

test("rate-limited native launch waits without effects and resumes at the existing window boundary", async () => {
  let now = 1000,
    effects = 0;
  const gate = new ManagedProcessAdmission(
    () => [],
    () => now,
  );
  for (let index = 0; index < 12; index++) gate.startNow("owner", () => effects++);
  const waits = [];
  const pending = gate.waitAndStart(
    "owner",
    () => effects++,
    () => {},
    undefined,
    (wait) => waits.push(wait),
  );
  assert.equal(effects, 12);
  assert.deepEqual(waits, [{ reason: "rate", retryAt: 61000 }]);
  now = 60999;
  gate.wake();
  assert.equal(effects, 12);
  now = 61000;
  gate.wake();
  await pending;
  assert.equal(effects, 13);
  assert.deepEqual(waits.at(-1), null);
});

test("blocked owners do not occupy capacity and eligible requests create records atomically", async () => {
  const active = ["full", "full", "full", "full"];
  const gate = new ManagedProcessAdmission(() => active);
  const controller = new globalThis.AbortController();
  const blocked = gate.waitAndStart(
    "full",
    () => active.push("full"),
    () => {},
    controller.signal,
  );
  const rejected = assert.rejects(blocked, /cancelled/);
  await gate.waitAndStart(
    "other",
    () => active.push("other"),
    () => {},
  );
  const more = Array.from({ length: 4 }, (_, index) =>
    gate.waitAndStart(
      `other-${index}`,
      () => active.push(`other-${index}`),
      () => {},
    ),
  );
  assert.equal(active.length, 8);
  controller.abort();
  await rejected;
  active.pop();
  gate.wake();
  await Promise.all(more);
  assert.equal(active.length, 8);
});

test("revoked authority, cancelled waits and stop-all cannot dispatch later", async () => {
  const active = Array(8).fill("busy");
  const gate = new ManagedProcessAdmission(() => active);
  let allowed = true,
    effects = 0;
  const revoked = gate.waitAndStart(
    "revoked",
    () => effects++,
    () => {
      if (!allowed) throw new Error("revoked");
    },
  );
  const revokeCheck = assert.rejects(revoked, /revoked/);
  allowed = false;
  gate.wake();
  await revokeCheck;
  const stopping = gate.waitAndStart(
    "stop",
    () => effects++,
    () => {},
  );
  const stopCheck = assert.rejects(stopping, /stopped/);
  gate.cancelAll();
  await stopCheck;
  active.length = 0;
  gate.wake();
  assert.equal(effects, 0);
});

test("admission rechecks authority after a wait notification before any effect", async () => {
  const active = Array(8).fill("busy");
  const gate = new ManagedProcessAdmission(() => active);
  let allowed = true,
    effects = 0;
  const pending = gate.waitAndStart(
    "owner",
    () => effects++,
    () => {
      if (!allowed) throw new Error("revoked");
    },
    undefined,
    (wait) => {
      if (wait === null) allowed = false;
    },
  );
  const failed = assert.rejects(pending, /revoked/);
  active.length = 0;
  gate.wake();
  await failed;
  assert.equal(effects, 0);
});

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-process-admission-"));
  const f = managedBashFixture(options);
  t.after(async () => {
    await f.service.stopAll("host");
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    ...f,
    cwd,
    start: (owner, signal, onAdmission) =>
      f.service.startForAgent(owner, cwd, true, { command: "fictional", waitFor: { type: "none" } }, signal, {
        context: f.context,
        onEvent() {},
        onAdmission,
      }),
  };
}

test("service queues a full owner, admits another owner, and waits for reaper acknowledgement before reusing capacity", async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const unregistering = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, {
    unregister: async () => {
      entered();
      await gate;
    },
  });
  await Promise.all(Array.from({ length: 4 }, () => f.start("full-owner")));
  let waiting;
  const queued = new Promise((resolve) => {
    waiting = resolve;
  });
  const pending = f.start("full-owner", undefined, waiting);
  try {
    assert.equal((await queued).reason, "session-capacity");
    await f.start("other-owner");
    assert.equal(f.backends.length, 5);
    f.backends[0].end();
    await unregistering;
    assert.equal(f.backends.length, 5);
    release();
    await pending;
    assert.equal(f.backends.length, 6);
  } finally {
    release();
    await pending;
  }
});

for (const scenario of ["abort", "stop-all"]) {
  test(`service cannot launch queued native Bash after ${scenario}`, async (t) => {
    const f = await fixture(t);
    const owner = `queued-${scenario}`;
    let waiting;

    await Promise.all(Array.from({ length: 4 }, () => f.start(owner)));
    const entered = new Promise((resolve) => {
      waiting = resolve;
    });
    const controller = new globalThis.AbortController();
    const pending = f.start(owner, controller.signal, waiting);
    const failed = assert.rejects(pending, /cancelled|authority|stopped/);
    await entered;
    if (scenario === "abort") controller.abort();
    if (scenario === "stop-all") await f.service.stopAll("host");
    await failed;
    assert.equal(f.backends.length, 4);
  });
}

test("simultaneous ordinary starts cannot exceed session capacity while resolving toolchains", async (t) => {
  let release,
    entered,
    resolving = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const full = new Promise((resolve) => {
    entered = resolve;
  });
  let f;
  f = await fixture(t, {
    serviceOptions: {
      runtime: {
        async createExecutionContext() {
          if (++resolving === 4) entered();
          await gate;
          return f.context;
        },
        requireFromContext(_capability, context) {
          return context.commands["shell.bash"];
        },
      },
    },
    onCommit(backend) {
      backend.emit({ type: "stdout", bytes: Buffer.from("READY\n") });
    },
  });
  const outcomes = Promise.allSettled(
    Array.from({ length: 8 }, () => f.service.startForAgent("ordinary", f.cwd, true, { command: "fictional" })),
  );
  await full;
  assert.equal(f.service.list(false, "ordinary").processes.length, 4);
  release();
  const results = await outcomes;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
  assert.equal(
    results.filter((result) => result.status === "rejected" && result.reason.code === "PROCESS_LIMIT_REACHED").length,
    4,
  );
  assert.equal(f.backends.length, 4);
});

test("restart waits for old recovery cleanup before creating a new generation", async (t) => {
  let f, release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const unregistering = new Promise((resolve) => {
    entered = resolve;
  });
  f = await fixture(t, {
    unregister: async () => {
      entered();
      await gate;
    },
    onCommit(backend) {
      backend.emit({ type: "stdout", bytes: Buffer.from("READY\n") });
    },
    serviceOptions: {
      runtime: {
        async createExecutionContext() {
          return f.context;
        },
        requireFromContext(_capability, context) {
          return context.commands["shell.bash"];
        },
      },
    },
  });
  const first = await f.service.startForAgent("restart-owner", f.cwd, true, { command: "fictional" });
  f.backends[0].end();
  await unregistering;
  const restarting = f.service.restart(first.process.processId, first.runId, "user");
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.backends.length, 1);
    release();
    assert.equal((await restarting).generation, 2);
    assert.equal(f.backends.length, 2);
  } finally {
    release();
    await restarting;
  }
});

test("ordinary restarts consume the same start-rate budget as new processes", async (t) => {
  let f;
  f = await fixture(t, {
    onCommit(backend) {
      backend.emit({ type: "stdout", bytes: Buffer.from("READY\n") });
    },
    serviceOptions: {
      runtime: {
        async createExecutionContext() {
          return f.context;
        },
        requireFromContext(_capability, context) {
          return context.commands["shell.bash"];
        },
      },
    },
  });
  let current = (await f.service.startForAgent("restart-rate-owner", f.cwd, true, { command: "fictional" })).process;
  for (let count = 1; count < 12; count++) current = await f.service.restart(current.processId, current.runId, "user");
  await assert.rejects(
    f.service.restart(current.processId, current.runId, "user"),
    (error) => error.code === "PROCESS_LIMIT_REACHED",
  );
  assert.equal(f.backends.length, 12);
  assert.equal(f.service.get(current.processId).generation, 12);
});

test("nonpermanent stop-all invalidates starts still awaiting preflight", async (t) => {
  let entered, release;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    serviceOptions: {
      parentCall: async (method) => {
        assert.equal(method, "managedProcesses.getSettings");
        entered();
        await gate;
        return { enabled: true, reaperReady: true };
      },
    },
  });
  const pending = f.start("preflight-owner");
  const rejected = assert.rejects(pending, /admission is unavailable/);
  await waiting;
  await f.service.stopAll("user", "force", false);
  release();
  await rejected;
  assert.equal(f.backends.length, 0);
});

test("an exited worker awaiting registration cannot be dismissed or restarted over the pending launch", async (t) => {
  let f, entered, release;
  let now = Date.now();
  const registered = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f = await fixture(t, {
    serviceOptions: {
      now: () => now,
      runtime: {
        async createExecutionContext() {
          return f.context;
        },
        requireFromContext(_capability, context) {
          return context.commands["shell.bash"];
        },
      },
      parentCall: async (method) => {
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        if (method === "managedProcesses.register") {
          entered();
          await gate;
          return { journalRevision: 1 };
        }
        if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
        throw new Error(`Unexpected fixture method ${method}`);
      },
    },
  });
  const pending = f.service.startForAgent("launch-owner", f.cwd, true, { command: "fictional" });
  const failed = assert.rejects(pending, /stopped before command commit/);
  await registered;
  const { processId, runId } = f.backends[0].input;
  try {
    f.backends[0].end();
    now += 16 * 60_000;
    assert.equal(
      f.service.list(true).processes.some((record) => record.processId === processId),
      true,
    );
    await assert.rejects(f.service.restart(processId, runId, "user"), /previous launch/);
    assert.throws(() => f.service.dismiss(processId), /launch and containment cleanup/);
    assert.equal(f.backends.length, 1);
  } finally {
    release();
    await failed;
  }
  assert.deepEqual(f.service.dismiss(processId), { ok: true });
});
