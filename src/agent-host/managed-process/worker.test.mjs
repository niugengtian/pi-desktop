import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launch(worker, request) {
  const nonce = "fictional-worker-handshake";
  const onReady = (event) => {
    if (event.type !== "prepared") return;
    worker.off("message", onReady);
    worker.send({ type: "commit", processId: request.processId, runId: request.runId, nonce, journalRevision: 1 });
  };
  worker.on("message", onReady);
  worker.send({ ...request, protocol: 2, nonce });
}

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function waitFor(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

for (const scenario of ["commit", "nonce", "runId", "processId", "revision", "stop", "disconnect", "legacy"]) {
  test(`worker prepare gate: ${scenario}`, { skip: process.platform === "win32", timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-commit-gate-"));
    const marker = path.join(directory, "effect");
    const worker = spawn(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(new URL("./worker.ts", import.meta.url))],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const events = [];
    worker.on("message", (event) => events.push(event));
    worker.stdout.resume();
    worker.stderr.resume();
    const closed = new Promise((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
    const bootstrap = {
      type: "bootstrap",
      protocol: 2,
      nonce: "fictional-journal-nonce",
      processId: "process-gate",
      runId: "run-gate",
      cwd: directory,
      command: `printf effect >> ${shellQuote(marker)}`,
      shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
    };
    try {
      worker.send(scenario === "legacy" ? { ...bootstrap, protocol: undefined, nonce: undefined } : bootstrap);
      if (scenario !== "legacy") {
        await waitFor(() => events.some((event) => event.type === "prepared"), 3_000, "worker did not prepare");
        // This real child must remain idle while its parent registers recovery.
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(
          events.some((event) => event.type === "started"),
          false,
        );
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        if (scenario === "stop") worker.send({ type: "stop", mode: "force", source: "host" });
        else if (scenario === "disconnect") worker.disconnect();
        else {
          const commit = {
            type: "commit",
            processId: bootstrap.processId,
            runId: bootstrap.runId,
            nonce: bootstrap.nonce,
            journalRevision: 1,
          };
          if (["nonce", "runId", "processId"].includes(scenario)) commit[scenario] = "wrong";
          if (scenario === "revision") commit.journalRevision = 0;
          worker.send(commit);
        }
      }
      const result = await closed;
      if (scenario === "commit") {
        assert.equal(await readFile(marker, "utf8"), "effect");
        assert.equal(events.filter((event) => event.type === "started").length, 1);
        assert.equal(events.find((event) => event.type === "exit").code, 0);
      } else {
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        assert.equal(
          events.some((event) => event.type === "started"),
          false,
        );
        assert.equal(result.code, ["stop", "disconnect"].includes(scenario) ? 0 : 2);
      }
    } finally {
      if (worker.pid && exists(worker.pid)) process.kill(-worker.pid, "SIGKILL");
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test(
  "worker strips its Electron bootstrap flag and does not load login profiles",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-worker-env-"));
    await writeFile(path.join(directory, ".bash_profile"), "export PI_MANAGED_LOGIN_PROFILE=loaded\n", "utf8");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerEntry], {
      cwd: directory,
      env: { ...process.env, HOME: directory, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    try {
      const closed = new Promise((resolve) => worker.once("close", resolve));
      launch(worker, {
        type: "bootstrap",
        processId: "proc-env",
        runId: "run-env",
        cwd: directory,
        command:
          'printf \'electron=%s profile=%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}" "${PI_MANAGED_LOGIN_PROFILE-unset}"',
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await closed;
      assert.equal(stdout, "electron=unset profile=unset\n");
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
);

test(
  "worker keeps a POSIX process group leased, forwards stdin/output, and reaps descendants",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-worker-"));
    const descendantFile = path.join(directory, "descendant.pid");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const appScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify("setInterval(() => {}, 1000)")}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));`,
      'console.log("READY http://127.0.0.1:43821/");',
      'process.stdin.on("data", (chunk) => process.stdout.write(`echo:${chunk}`));',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(appScript)}`;
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerEntry], {
      cwd: directory,
      env: { ...process.env, PI_DESKTOP_MANAGED_PROCESS: "1" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let descendantPid;
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    try {
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker start timed out")), 5_000);
        worker.on("message", (message) => {
          if (message?.type !== "started") return;
          clearTimeout(timer);
          resolve(message);
        });
      });
      launch(worker, {
        type: "bootstrap",
        processId: "proc-test",
        runId: "run-test",
        cwd: directory,
        command,
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await started;
      await waitFor(() => stdout.includes("READY http://127.0.0.1:43821/"), 5_000, "readiness output missing");
      descendantPid = Number(await readFile(descendantFile, "utf8"));
      assert.equal(exists(descendantPid), true);

      worker.send({ type: "stdin", text: "hello", appendNewline: true, close: false });
      await waitFor(() => stdout.includes("echo:hello"), 2_000, "stdin was not forwarded");

      const closed = new Promise((resolve) => worker.once("close", resolve));
      worker.send({ type: "stop", mode: "graceful", source: "user" });
      await closed;
      await waitFor(() => !exists(descendantPid), 2_000, "descendant survived managed group stop");
      assert.equal(exists(worker.pid), false);
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
      if (descendantPid && exists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
);

test(
  "worker lease disconnect cleans the process group without a Host stop message",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-lease-"));
    const descendantFile = path.join(directory, "descendant.pid");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const appScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify("setInterval(() => {}, 1000)")}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));`,
      'console.log("LEASE_READY");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerEntry], {
      cwd: directory,
      env: { ...process.env },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let descendantPid;
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    try {
      launch(worker, {
        type: "bootstrap",
        processId: "proc-lease",
        runId: "run-lease",
        cwd: directory,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(appScript)}`,
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await waitFor(() => stdout.includes("LEASE_READY"), 5_000, "lease fixture did not start");
      descendantPid = Number(await readFile(descendantFile, "utf8"));
      worker.disconnect();
      await waitFor(() => !exists(worker.pid), 8_000, "worker survived lease disconnect");
      await waitFor(() => !exists(descendantPid), 2_000, "lease disconnect left a descendant running");
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
      if (descendantPid && exists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
);

for (const scenario of ["root-exit", "lease-disconnect", "disconnect-after-exit", "force-after-graceful"]) {
  for (const stdio of ["inherit", "ignore"]) {
    test(
      `${scenario} reaps signal-ignoring descendants with ${stdio} stdio`,
      { skip: process.platform === "win32", timeout: 10_000 },
      async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-root-exit-"));
        const descendantFile = path.join(directory, "descendant.pid");
        const descendantScript = [
          'const fs = require("node:fs");',
          'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});',
          `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join(" ");
        const exits = scenario === "root-exit" || scenario === "disconnect-after-exit";
        const rootScript = [
          'const { spawn } = require("node:child_process"); const fs = require("node:fs");',
          scenario === "force-after-graceful" ? 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});' : "",
          `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ${JSON.stringify(stdio)} });`,
          `const ready = setInterval(() => { if (!fs.existsSync(${JSON.stringify(descendantFile)})) return; clearInterval(ready); console.log("ROOT_READY"); ${exits ? "process.exit(23);" : "setInterval(() => {}, 1000);"} }, 10);`,
        ].join(" ");
        const worker = spawn(
          process.execPath,
          ["--experimental-strip-types", fileURLToPath(new URL("./worker.ts", import.meta.url))],
          {
            cwd: directory,
            env: { ...process.env },
            detached: true,
            shell: false,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        const events = [];
        let stdout = "",
          descendantPid;
        worker.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        worker.stderr.resume();
        worker.on("message", (event) => {
          events.push(event);
          if (scenario === "disconnect-after-exit" && event.type === "exit" && worker.connected) worker.disconnect();
        });
        try {
          launch(worker, {
            type: "bootstrap",
            processId: "proc-root-exit",
            runId: "run-root-exit",
            cwd: directory,
            command: `${shellQuote(process.execPath)} -e ${shellQuote(rootScript)}`,
            shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
          });
          await waitFor(() => stdout.includes("ROOT_READY"), 4_000, "root did not start");
          descendantPid = Number(await readFile(descendantFile, "utf8"));
          if (scenario === "lease-disconnect") worker.disconnect();
          if (scenario === "force-after-graceful") {
            worker.send({ type: "stop", mode: "graceful", source: "user" });
            await waitFor(
              () => events.some((event) => event.type === "stopping" && event.phase === "interrupt"),
              1_000,
              "graceful stop did not begin",
            );
            worker.send({ type: "stop", mode: "force", source: "user" });
          }
          await waitFor(
            () => !exists(worker.pid) && !exists(descendantPid),
            1_500,
            "root completion left its worker or descendant alive",
          );
          if (exits)
            assert.deepEqual(
              events.filter((event) => event.type === "exit"),
              [{ type: "exit", code: 23 }],
            );
        } finally {
          if (worker.pid && exists(worker.pid)) {
            try {
              process.kill(-worker.pid, "SIGKILL");
            } catch {
              /* own test group */
            }
          }
          if (descendantPid && exists(descendantPid)) {
            try {
              process.kill(descendantPid, "SIGKILL");
            } catch {
              /* own test descendant */
            }
          }
          await waitFor(
            () => !exists(worker.pid) && (!descendantPid || !exists(descendantPid)),
            2_000,
            "fixture cleanup did not finish",
          );
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
}

test(
  "worker reports shell spawn failure and exits without waiting for a nonexistent child exit",
  { skip: process.platform === "win32", timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-spawn-failure-"));
    const worker = spawn(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(new URL("./worker.ts", import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env },
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const events = [];
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on("message", (event) => events.push(event));
    try {
      const closed = new Promise((resolve) => worker.once("close", resolve));
      launch(worker, {
        type: "bootstrap",
        processId: "proc-missing",
        runId: "run-missing",
        cwd: directory,
        command: "unused",
        shell: { executable: path.join(directory, "missing-shell"), argvPrefix: [], cwdSemantics: "native" },
      });
      assert.equal(await closed, 2);
      assert.equal(events.filter((event) => event.type === "error" && event.code === "SPAWN_FAILED").length, 1);
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* own test group */
        }
      }
      await waitFor(() => !exists(worker.pid), 1_000, "failed-spawn worker did not exit");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "root cleanup preserves buffered stdout, stderr and the actual root exit code",
  { skip: process.platform === "win32", timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-output-exit-"));
    const worker = spawn(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(new URL("./worker.ts", import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env },
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const events = [];
    let stdout = "",
      stderr = "";
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    worker.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    worker.on("message", (event) => events.push(event));
    try {
      const closed = new Promise((resolve) => worker.once("close", resolve));
      const script =
        'let pending = 2; const done = () => { if (--pending === 0) process.exit(7); }; process.stdout.write("OUT_BEGIN" + "o".repeat(262144) + "OUT_END", done); process.stderr.write("ERR_BEGIN" + "e".repeat(262144) + "ERR_END", done);';
      launch(worker, {
        type: "bootstrap",
        processId: "proc-output",
        runId: "run-output",
        cwd: directory,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await closed;
      assert.equal(stdout, "OUT_BEGIN" + "o".repeat(262144) + "OUT_END");
      assert.equal(stderr.slice(stderr.indexOf("ERR_BEGIN")), "ERR_BEGIN" + "e".repeat(262144) + "ERR_END");
      assert.deepEqual(
        events.filter((event) => event.type === "exit"),
        [{ type: "exit", code: 7 }],
      );
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* own test group */
        }
      }
      await waitFor(() => !exists(worker.pid), 1_000, "output worker did not exit");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
