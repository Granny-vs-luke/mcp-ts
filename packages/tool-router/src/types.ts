export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  [key: string]: unknown;
}

export interface ToolServer {
  id: string;
  name?: string;
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  refresh?(): Promise<void>;
}

export interface IndexedTool {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  deferred?: boolean;
  annotations?: ToolAnnotations;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface ToolSearchResult {
  toolId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  score: number;
}

export interface SearchStrategy {
  search(tools: IndexedTool[], request: ToolSearchRequest, limit: number): ToolSearchResult[];
}

export interface ToolSchemaResult {
  toolId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface PinnedToolResult extends ToolSchemaResult {
  annotations?: ToolAnnotations;
}

export type ToolRouterDetailLevel = "brief" | "detailed" | "full";

export interface VisibleTools {
  pinned: PinnedToolResult[];
  metaTools: ToolRouterMetaTool[];
}

export interface ToolRouterPolicy {
  allowTools?: string[];
  denyTools?: string[];
  denyDestructiveTools?: boolean;
  approveToolCall?: (call: ToolCallRequest & { tool: IndexedTool }) => boolean | Promise<boolean>;
}

export interface ToolRouterOptions {
  servers: ToolServer[];
  policy?: ToolRouterPolicy;
  searchStrategy?: SearchStrategy;
  /** Canonical tool ids (serverId.toolName) or legacy tool names always visible alongside meta-tools. */
  pinnedTools?: string[];
  /** Tools omitted from direct exposure but kept indexed for meta-tool search/schema/call flows. */
  deferredTools?: string[];
  /** Canonical tool ids/patterns or legacy tool names/patterns to omit from the router catalog. */
  excludeTools?: string[];
  maxSearchResults?: number;
  excludeMetaTools?: string[];
  metaToolNames?: Partial<{
    searchTools: string;
    listServers: string;
    getToolSchemas: string;
    callTool: string;
  }>;
}

export interface ToolSearchRequest {
  query?: string;
  serverId?: string;
  serverName?: string;
  limit?: number;
  detail?: ToolRouterDetailLevel;
}

export interface ToolSchemaRequest {
  toolIds: string[];
}

export interface ToolCallRequest {
  toolId: string;
  args?: Record<string, unknown>;
}

export interface ToolRouterMetaTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: ToolAnnotations;
}

export interface ToolRouterMetaToolNames {
  searchTools: string;
  listServers: string;
  getToolSchemas: string;
  callTool: string;
}

export interface ToolRouterCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}
