export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  [key: string]: unknown;
}

export interface ToolSource {
  id: string;
  name?: string;
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface IndexedTool {
  sourceId: string;
  sourceName: string;
  toolName: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema?: unknown;
}

export interface ToolSearchResult {
  sourceId: string;
  sourceName: string;
  toolName: string;
  description: string;
  annotations?: ToolAnnotations;
  score: number;
}

export interface ToolRouterPolicy {
  allowTools?: string[];
  denyTools?: string[];
  denyDestructiveTools?: boolean;
  approveToolCall?: (call: ToolCallRequest & { tool: IndexedTool }) => boolean | Promise<boolean>;
}

export interface ToolRouterOptions {
  sources: ToolSource[];
  policy?: ToolRouterPolicy;
  maxSearchResults?: number;
}

export interface ToolSearchRequest {
  query?: string;
  sourceId?: string;
  sourceName?: string;
  limit?: number;
}

export interface ToolSchemaRequest {
  sourceId?: string;
  sourceName?: string;
  toolName: string;
}

export interface ToolCallRequest extends ToolSchemaRequest {
  args?: Record<string, unknown>;
}

export interface ToolRouterMetaTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolRouterCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}
