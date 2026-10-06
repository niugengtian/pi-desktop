import { MANAGED_PROCESS_LIMITS } from "../../shared/managed-process-policy.ts";
import { ManagedProcessError } from "./lifecycle-utils.ts";

export type ProcessAdmissionWait = { reason: "rate" | "global-capacity" | "session-capacity"; retryAt?: number };
type Request = {
  owner: string;
  check: () => void;
  start: () => void;
  reject: (error: unknown) => void;
  notify: (wait: ProcessAdmissionWait) => void;
  removeAbort: () => void;
};

/** Single-Host admission. Capacity check and record creation happen synchronously together. */
export class ManagedProcessAdmission {
  private starts: number[] = [];
  private pending: Request[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private readonly activeOwners: () => string[];
  private readonly now: () => number;

  constructor(activeOwners: () => string[], now: () => number = Date.now) {
    this.activeOwners = activeOwners;
    this.now = now;
  }

  private blocked(owner: string): ProcessAdmissionWait | undefined {
    const now = this.now();
    this.starts = this.starts.filter((at) => now - at < 60_000);
    if (this.starts.length >= 12) return { reason: "rate", retryAt: this.starts[0] + 60_000 };
    const active = this.activeOwners();
    if (active.length >= MANAGED_PROCESS_LIMITS.globalActive) return { reason: "global-capacity" };
    if (active.filter((value) => value === owner).length >= MANAGED_PROCESS_LIMITS.sessionActive)
      return { reason: "session-capacity" };
    return undefined;
  }

  startNow<T>(owner: string, start: () => T): T {
    const blocked = this.blocked(owner);
    if (blocked)
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", `Managed process admission blocked: ${blocked.reason}`);
    this.starts.push(this.now());
    return start();
  }

  waitAndStart<T>(
    owner: string,
    start: () => T,
    check: () => void,
    signal?: AbortSignal,
    onWait?: (wait: ProcessAdmissionWait | null) => void,
  ): Promise<T> {
    if (this.pending.length >= 64)
      return Promise.reject(
        new ManagedProcessError("PROCESS_LIMIT_REACHED", "Managed process admission queue is full"),
      );
    return new Promise<T>((resolve, reject) => {
      let lastWait: string | undefined;
      const request: Request = {
        owner,
        check: () => {
          if (signal?.aborted)
            throw new ManagedProcessError("PROCESS_USER_STOPPED", "Managed process admission cancelled");
          check();
        },
        start: () => {
          // A notification may itself revoke authority. Check again before record creation.
          if (lastWait) onWait?.(null);
          request.check();
          resolve(this.startNow(owner, start));
        },
        reject,
        notify: (wait) => {
          const key = JSON.stringify(wait);
          if (key !== lastWait) {
            onWait?.(wait);
            lastWait = key;
          }
        },
        removeAbort: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        this.remove(request);
        reject(new ManagedProcessError("PROCESS_USER_STOPPED", "Managed process admission cancelled"));
        this.wake();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(request);
      this.wake();
    });
  }

  cancelAll(): void {
    for (const request of [...this.pending]) {
      this.remove(request);
      request.reject(new ManagedProcessError("PROCESS_USER_STOPPED", "Managed process admission stopped"));
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private remove(request: Request): void {
    this.pending = this.pending.filter((entry) => entry !== request);
    request.removeAbort();
  }

  wake(): void {
    if (this.draining) return;
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      // A full session does not prevent another owner from using global capacity.
      for (const request of [...this.pending]) {
        if (!this.pending.includes(request)) continue;
        try {
          request.check();
          const blocked = this.blocked(request.owner);
          if (blocked) {
            request.notify(blocked);
            continue;
          }
          this.remove(request);
          request.start();
        } catch (error) {
          this.remove(request);
          request.reject(error);
        }
      }
    } finally {
      this.draining = false;
      if (this.pending.length) {
        // Recheck authority even without a process event; rate limits expire without one.
        this.timer = setTimeout(() => this.wake(), 1_000);
        this.timer.unref();
      }
    }
  }
}
