import type { IndexedTool, ToolCallRequest, ToolRouterPolicy } from "./types.js";

export function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function toolAddress(serverId: string, toolName: string): string {
  return `${serverId}.${toolName}`;
}

export class PolicyEnforcer {
  constructor(private policy?: ToolRouterPolicy) {}

  isToolVisible(tool: IndexedTool): boolean {
    const address = toolAddress(tool.serverId, tool.toolName);

    if (this.policy?.allowTools?.length) {
      const allowed = this.policy.allowTools.some((pattern) => wildcardMatch(pattern, address));
      if (!allowed) {
        return false;
      }
    }

    if (this.policy?.denyTools?.some((pattern) => wildcardMatch(pattern, address))) {
      return false;
    }

    return true;
  }

  async assertToolAllowed(request: ToolCallRequest, tool: IndexedTool): Promise<void> {
    const address = toolAddress(tool.serverId, tool.toolName);
    if (!this.isToolVisible(tool)) {
      const deniedByAllowList = this.policy?.allowTools?.length
        ? !this.policy.allowTools.some((pattern) => wildcardMatch(pattern, address))
        : false;
      if (deniedByAllowList) {
        throw new Error(`Policy denied tool call to "${address}": not in allowTools.`);
      }
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
