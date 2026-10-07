import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
export class ModelSessions {
  constructor(options?: { acquire?: (provider: string) => () => void });
  install(session: AgentSession): void;
  currentId(): string | undefined;
  extension(): { name: string; hidden: boolean; factory: (pi: ExtensionAPI) => void };
}
