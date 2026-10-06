import type { Deferred } from "./lifecycle-utils.ts";
import type { ManagedProcessBackend, ManagedProcessExecution } from "./backend.ts";
import type { ManagedProcessOutputBuffer, ManagedProcessOutputDecoder } from "./output-buffer.ts";
import type {
  ManagedLoopbackEndpoint,
  ManagedProcessKind,
  ManagedProcessState,
  ManagedProcessReadiness,
  ManagedProcessWaitFor,
  ManagedProcessExit,
  ManagedProcessStopSource,
  ManagedProcessReaperRecord,
} from "../../contract/processes.ts";

export type Waiter = { resolve: () => void };

export type ManagedRecord = {
  launchPending: boolean;
  execution?: ManagedProcessExecution;
  nativeBash?: boolean;
  processId: string;
  runId: string;
  generation: number;
  label: string;
  kind: ManagedProcessKind;
  state: ManagedProcessState;
  readiness: ManagedProcessReadiness;
  readinessSpec: ManagedProcessWaitFor;
  readinessMatched?: string;
  ownerSessionId: string;
  ownerCwd: string;
  cwd: string;
  command: string;
  activateUi: boolean;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  stdinOpen: boolean;
  endpoints: ManagedLoopbackEndpoint[];
  networkWarnings: string[];
  restartCount: number;
  exit?: ManagedProcessExit;
  output: ManagedProcessOutputBuffer;
  decoder: ManagedProcessOutputDecoder;
  backend?: ManagedProcessBackend;
  removeBackendListener?: () => void;
  finish?: Deferred;
  stopSource?: ManagedProcessStopSource;
  userStopBarrier: boolean;
  waiters: Set<Waiter>;
  outputNotifyTimer?: ReturnType<typeof setTimeout>;
  reaper?: ManagedProcessReaperRecord;
  reaperRegistered: boolean;
  stdinWindow: Array<{ at: number; bytes: number }>;
  agentWaitActive: boolean;
};
