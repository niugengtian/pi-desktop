import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import path from "node:path";
import { importTestBundle } from "#test-bundle";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
const { OllamaService } = await importTestBundle("ollama-service", {
  entryPoints: [path.join(import.meta.dirname, "ollama-service.ts")],
  packages: "external",
  absWorkingDir: path.resolve(import.meta.dirname, "../.."),
});

function fixture(overrides = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 20100000,
    exitCode: null,
    signalCode: null,
    kill: () => {
      throw Error("external signal forbidden");
    },
  });
  const calls = { probe: 0, spawn: 0, cleanup: [], records: [], env: null, emergency: [] };
  const status = () => ({ ready: true, revision: 1, records: calls.records.length });
  const options = {
    reaper: {
      status,
      register: (record) => {
        calls.records.push(record);
        return { journalRevision: 1 };
      },
      reapAll: async (owner) => {
        calls.cleanup.push(owner);
        assert.ok(calls.records.every((r) => r.hostInstanceId === owner));
        calls.records.length = 0;
        child.exitCode = 0;
        child.emit("exit", 0);
        return status();
      },
    },
    probe: async () => {
      calls.probe++;
      return calls.spawn ? "ready" : "unavailable";
    },
    findBinary: async () => "/fictional/ollama",
    platform: "darwin",
    fingerprint: async () => "fictional-start",
    spawn: (_binary, env) => {
      calls.spawn++;
      calls.env = env;
      return child;
    },
    terminate: async (pid) => {
      calls.emergency.push(pid);
      return true;
    },
    ...overrides,
  };
  return { service: new OllamaService(options), calls, child };
}

test("default/off never probes, starts, downloads or signals a service", async () => {
  const { service, calls } = fixture();
  await service.configure(false);
  await service.stop();
  assert.equal(service.getState(), "disabled");
  assert.equal(calls.probe, 0);
  assert.equal(calls.spawn, 0);
  assert.deepEqual(calls.cleanup, []);
});

test("an existing Ollama is reused and survives disable and App shutdown", async () => {
  const { service, calls } = fixture({
    probe: async () => "ready",
    spawn: () => {
      throw Error("must not spawn");
    },
  });
  await service.configure(true);
  assert.equal(service.getState(), "external");
  await service.configure(false);
  await service.stop();
  assert.deepEqual(calls.cleanup, []);
});

test("app-owned startup is loopback/cloud-off and journal-backed; shutdown cleans only its owner", async () => {
  const { service, calls } = fixture();
  await service.configure(true);
  assert.equal(service.getState(), "owned");
  assert.equal(calls.env.OLLAMA_HOST, "127.0.0.1:11434");
  assert.equal(calls.env.OLLAMA_NO_CLOUD, "1");
  assert.equal(calls.records[0].pid, calls.records[0].pgid);
  assert.equal(calls.records[0].startFingerprint, "fictional-start");
  const owner = calls.records[0].hostInstanceId;
  await service.configure(true);
  assert.equal(calls.spawn, 1);
  await service.stop();
  assert.deepEqual(calls.cleanup, [owner]);
  assert.equal(service.getState(), "disabled");
});

test("occupied port, missing binary and unavailable cleanup each refuse startup", async () => {
  for (const [overrides, message] of [
    [{ probe: async () => "occupied" }, /occupied/],
    [{ findBinary: async () => null }, /not installed/],
    [{ reaper: { status: () => ({ ready: false }) } }, /cleanup journal/],
    [{ platform: "win32" }, /Windows/],
  ]) {
    const { service, calls } = fixture(overrides);
    await assert.rejects(service.configure(true), message);
    assert.equal(service.getState(), "failed");
    assert.equal(calls.spawn, 0);
  }
});

test("disable during asynchronous discovery cancels the stale startup without spawning", async () => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const { service, calls } = fixture({ probe: () => pending });
  const on = service.configure(true);
  await Promise.resolve();
  const off = service.configure(false);
  resolve("unavailable");
  await Promise.all([on, off]);
  assert.equal(calls.spawn, 0);
  assert.equal(service.getState(), "disabled");
});

test(
  "real app-owned process registration and loopback readiness survive a second enable, then shut down cleanly",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ollama-owned-fixture-"));
    let service;
    t.after(async () => {
      try {
        await service?.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    const { ManagedProcessReaper } = await importTestBundle("ollama-reaper-integration", {
      entryPoints: [path.join(import.meta.dirname, "managed-process/reaper.ts")],
      packages: "external",
      absWorkingDir: path.resolve(import.meta.dirname, "../.."),
    });
    const reaper = new ManagedProcessReaper(path.join(dir, "journal.json"));
    assert.equal((await reaper.initialize()).ready, true);
    const portFile = path.join(dir, "port.json");
    const binary = path.join(dir, "fictional-server.mjs");
    writeFileSync(
      binary,
      `import http from 'node:http'; import fs from 'node:fs'; const s=http.createServer((_q,r)=>r.end(JSON.stringify({version:'0.0.0'})));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(s.address().port)));`,
    );
    service = new OllamaService({
      reaper,
      findBinary: async () => binary,
      startupMs: 5000,
      spawn: (file, env) => spawn(process.execPath, [file], { env, shell: false, detached: true, stdio: "ignore" }),
      probe: async () => {
        if (!existsSync(portFile)) return "unavailable";
        try {
          const response = await globalThis.fetch(`http://127.0.0.1:${readFileSync(portFile, "utf8")}/api/version`);
          return (await response.json()).version === "0.0.0" ? "ready" : "occupied";
        } catch {
          return "unavailable";
        }
      },
    });
    await service.configure(true);
    assert.equal(service.getState(), "owned");
    assert.equal(reaper.status().records, 1);
    await service.configure(true);
    assert.equal(reaper.status().records, 1);
    await service.stop();
    assert.equal(service.getState(), "disabled");
    assert.equal(reaper.status().records, 0);
  },
);

test("missing ownership fingerprint performs only injected emergency cleanup on the new child", async () => {
  const { service, calls, child } = fixture({ fingerprint: async () => null });
  await assert.rejects(service.configure(true), /ownership/);
  assert.deepEqual(calls.emergency, [child.pid]);
  assert.equal(calls.records.length, 0);
});
