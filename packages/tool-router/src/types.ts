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
  annotations?: ToolAnnotations;
  [key: string]: unknown;
}

export interface ToolSource {
  id: string;
  name?: string;
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  refresh?(): Promise<void>;
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
  score: number;
}

export interface SearchStrategy {
  search(tools: IndexedTool[], request: ToolSearchRequest, limit: number): ToolSearchResult[];
}

export interface ToolSchemaResult {
  sourceId: string;
  sourceName: string;
  toolName: string;
  description: string;
  inputSchema?: unknown;
}

export interface PinnedToolResult extends ToolSchemaResult {
  annotations?: ToolAnnotations;
}

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
  sources: ToolSource[];
  policy?: ToolRouterPolicy;
  searchStrategy?: SearchStrategy;
  pinnedTools?: string[];            // tool names always visible alongside meta-tools
  maxSearchResults?: number;
  excludeMetaTools?: string[];
  metaToolNames?: Partial<{
    searchTools: string;
    listSources: string;
    getToolSchema: string;
    callTool: string;
  }>;
}

export interface ToolSearchRequest {
  query?: string;
  sourceId?: string;
  sourceName?: string;
  limit?: number;
  /** Internal: pinned tool names to exclude from search results (set by ToolRouter). */
  _pinnedTools?: Set<string>;
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
  annotations?: ToolAnnotations;
}

export interface ToolRouterMetaToolNames {
  searchTools: string;
  listSources: string;
  getToolSchema: string;
  callTool: string;
}

export interface ToolRouterCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}
