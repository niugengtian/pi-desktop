import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SharedTerminalService } from "./service";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function createSharedTerminalToolDefinitions(
  sessionId: string,
  cwd: string,
  service: SharedTerminalService,
): ToolDefinition[] {
  return [
    defineTool({
      name: "shared_terminal_read",
      label: "读取共享终端",
      description: "读取当前 PI 会话共享终端最近的输出。用于查看用户或后台任务在终端中的最新结果。",
      promptSnippet: "shared_terminal_read: 读取当前会话共享终端的最近输出。",
      promptGuidelines: ["需要了解共享终端当前或最后输出时，先调用 shared_terminal_read，不要猜测。"],
      parameters: Type.Object({ lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        await service.ensure(sessionId, cwd);
        const result = await service.capture(sessionId, input.lines ?? 200);
        return textResult(result.text || "（终端暂无输出）");
      },
    }),
    defineTool({
      name: "shared_terminal_send",
      label: "发送到共享终端",
      description: "向当前 PI 会话的共享终端发送文本，可选择是否按回车执行。",
      promptSnippet: "shared_terminal_send: 向当前会话共享终端发送文本。",
      promptGuidelines: ["只在用户要求共享操作终端时使用；发送有副作用的命令前遵循现有授权规则。"],
      parameters: Type.Object({
        text: Type.String({ maxLength: 65536 }),
        enter: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        await service.ensure(sessionId, cwd);
        await service.send(sessionId, input.text, input.enter !== false);
        return textResult("已发送到共享终端。");
      },
    }),
  ];
}
