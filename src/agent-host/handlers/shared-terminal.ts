import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { assertPathAllowed } from "../path-authorization";
import type { SharedTerminalService } from "../shared-terminal/service";

type SharedTerminalHandlers = {
  probe: NonNullable<ApiHandler["sharedTerminal.probe"]>;
  ensure: NonNullable<ApiHandler["sharedTerminal.ensure"]>;
  attach: NonNullable<ApiHandler["sharedTerminal.attach"]>;
  write: NonNullable<ApiHandler["sharedTerminal.write"]>;
  resize: NonNullable<ApiHandler["sharedTerminal.resize"]>;
  detach: NonNullable<ApiHandler["sharedTerminal.detach"]>;
  capture: NonNullable<ApiHandler["sharedTerminal.capture"]>;
  send: NonNullable<ApiHandler["sharedTerminal.send"]>;
  status: NonNullable<ApiHandler["sharedTerminal.status"]>;
  close: NonNullable<ApiHandler["sharedTerminal.close"]>;
};

function identity(params: unknown): { sessionId: string; cwd: string } {
  const { sessionId, cwd } = params as { sessionId: string; cwd: string };
  if (!sessionId?.trim() || !cwd?.trim()) throw new RpcError({ code: "BAD_REQUEST", message: "会话和目录不能为空" });
  return { sessionId, cwd };
}

export function createSharedTerminalHandlers(service: SharedTerminalService) {
  return {
    probe: (params) => service.probe((params as { refresh?: boolean } | undefined)?.refresh === true),
    ensure: async (params) => {
      const { sessionId, cwd } = identity(params);
      await assertPathAllowed(cwd);
      return service.ensure(sessionId, cwd);
    },
    attach: async (params) => {
      const { sessionId, cwd } = identity(params);
      const { cols, rows } = params as { cols: number; rows: number };
      await assertPathAllowed(cwd);
      return service.attach(sessionId, cwd, cols, rows);
    },
    write: (params) => {
      const { sessionId, data } = params as { sessionId: string; data: string };
      return service.write(sessionId, data);
    },
    resize: (params) => {
      const { sessionId, cols, rows } = params as { sessionId: string; cols: number; rows: number };
      return service.resize(sessionId, cols, rows);
    },
    detach: (params) => service.detach((params as { sessionId: string }).sessionId),
    capture: (params) => {
      const { sessionId, lines } = params as { sessionId: string; lines?: number };
      return service.capture(sessionId, lines);
    },
    send: (params) => {
      const { sessionId, text, enter } = params as { sessionId: string; text: string; enter?: boolean };
      return service.send(sessionId, text, enter !== false);
    },
    status: (params) => service.status((params as { sessionId: string }).sessionId),
    close: (params) => service.close((params as { sessionId: string }).sessionId),
  } satisfies SharedTerminalHandlers;
}
