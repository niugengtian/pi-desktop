import type { ManagedProcessErrorCode } from "../../contract/processes.ts";

export type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

export class ManagedProcessError extends Error {
  readonly code: ManagedProcessErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ManagedProcessErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ManagedProcessError";
    this.code = code;
    this.details = details;
  }
}

export function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  code: ManagedProcessErrorCode = "PROCESS_STOP_TIMEOUT",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ManagedProcessError(code, message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
