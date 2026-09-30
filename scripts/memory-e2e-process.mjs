import { terminateProcessTree } from "./process-utils.mjs";

// Four bounded stages plus Host startup/restart and RPC setup. This is an
// aggregate test budget, not a change to production inference timeouts.
export const MEMORY_E2E_TOTAL_BUDGET_MS = 4 * 135_000 + 25_000 + 35_000;

export function waitForMemoryFixture(
  child,
  { timeoutMs = MEMORY_E2E_TOTAL_BUDGET_MS, terminate = terminateProcessTree } = {},
) {
  return new Promise((resolve) => {
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error("Memory E2E total stage budget exhausted");
      terminate(child);
      escalation = setTimeout(() => terminate(child, { signal: "SIGKILL" }), 5_000);
    }, timeoutMs);
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
    };
    child.once("error", (error) => {
      clear();
      console.error(error);
      resolve(1);
    });
    // Cleanup must not race Electron/Host writers still using the profile.
    child.once("close", (code) => {
      clear();
      resolve(timedOut ? 1 : (code ?? 1));
    });
  });
}
