declare module "@mcp-ts/toolrouter" {
  export interface ToolSearchResult {
    sourceId: string;
    sourceName: string;
    toolName: string;
    description: string;
    annotations?: Record<string, unknown>;
    score: number;
  }

  export interface ToolCallRequest {
    sourceId?: string;
    sourceName?: string;
    toolName: string;
    args?: Record<string, unknown>;
  }

  export interface ToolRouterPolicy {
    allowTools?: string[];
    denyTools?: string[];
    denyDestructiveTools?: boolean;
    approveToolCall?: (call: ToolCallRequest & { tool: unknown }) => boolean | Promise<boolean>;
  }

  export interface ToolRouter {
    searchTools(request: { query?: string; limit?: number; sourceId?: string; sourceName?: string }): Promise<ToolSearchResult[]>;
    callTool(request: ToolCallRequest): Promise<unknown>;
  }
}
