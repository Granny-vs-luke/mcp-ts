import type { IndexedTool, ToolCallRequest, ToolRouterPolicy } from "./types.js";

export function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function toolAddress(sourceId: string, toolName: string): string {
  return `${sourceId}.${toolName}`;
}

export class PolicyEnforcer {
  constructor(private policy?: ToolRouterPolicy) {}

  async assertToolAllowed(request: ToolCallRequest, tool: IndexedTool): Promise<void> {
    const address = toolAddress(tool.sourceId, tool.toolName);

    if (this.policy?.allowTools?.length) {
      const allowed = this.policy.allowTools.some((pattern) => wildcardMatch(pattern, address));
      if (!allowed) {
        throw new Error(`Policy denied tool call to "${address}": not in allowTools.`);
      }
    }

    if (this.policy?.denyTools?.some((pattern) => wildcardMatch(pattern, address))) {
      throw new Error(`Policy denied tool call to "${address}": matched denyTools.`);
    }

    if (this.policy?.denyDestructiveTools && tool.annotations?.destructiveHint === true) {
      const approved = await this.policy.approveToolCall?.({ ...request, tool });
      if (!approved) {
        throw new Error(`Policy denied tool call to "${address}": destructive tool requires approval.`);
      }
    }
  }
}
