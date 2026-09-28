import type { RpcServer } from "../../contract/rpc.ts";
import { SharedTerminalService } from "./service.ts";

let service: SharedTerminalService | null = null;

export function initializeSharedTerminalService(server: Pick<RpcServer, "emit">): SharedTerminalService {
  service ??= new SharedTerminalService(server);
  return service;
}

export function peekSharedTerminalService(): SharedTerminalService | null {
  return service;
}
