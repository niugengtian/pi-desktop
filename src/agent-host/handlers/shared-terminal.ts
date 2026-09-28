import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { assertPathAllowed } from "../path-authorization";
import type { SharedTerminalService } from "../shared-terminal/service";

type SharedTerminalHandlers = {
  probe: NonNullable<ApiHandler["sharedTerminal.probe"]>;
  ensure: NonNullable<ApiHandler["sharedTerminal.ensure"]>;
  status: NonNullable<ApiHandler["sharedTerminal.status"]>;
  close: NonNullable<ApiHandler["sharedTerminal.close"]>;
};

export function createSharedTerminalHandlers(service: SharedTerminalService) {
  return {
    probe: (params) => service.probe((params as { refresh?: boolean } | undefined)?.refresh === true),
    ensure: async (params) => {
      const { sessionId, cwd } = params as { sessionId: string; cwd: string };
      if (!sessionId?.trim() || !cwd?.trim())
        throw new RpcError({ code: "BAD_REQUEST", message: "会话和目录不能为空" });
      await assertPathAllowed(cwd);
      return service.ensure(sessionId, cwd);
    },
    status: (params) => service.status((params as { sessionId: string }).sessionId),
    close: (params) => service.close((params as { sessionId: string }).sessionId),
  } satisfies SharedTerminalHandlers;
}
