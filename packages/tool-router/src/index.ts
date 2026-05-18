export { ToolRouter, createToolRouter } from "./router.js";
export {
  createMetaTools,
  DEFAULT_TOOLROUTER_META_TOOL_NAMES
} from "./meta-tools.js";
export { createAISDKTools, asToolServer } from "./adapters/ai-sdk.js";
export { mcpServer, mcpServers } from "./adapters/mcp.js";
export { BM25SearchStrategy } from "./search.js";
export { PolicyEnforcer } from "./policy.js";
export type {
  IndexedTool,
  PinnedToolResult,
  SearchStrategy,
  ToolAnnotations,
  ToolCallRequest,
  ToolDefinition,
  ToolRouterCallResult,
  ToolRouterMetaTool,
  ToolRouterMetaToolNames,
  ToolRouterOptions,
  ToolRouterPolicy,
  ToolSchemaResult,
  ToolSchemaRequest,
  ToolSearchRequest,
  ToolSearchResult,
  ToolServer,
  VisibleTools
} from "./types.js";
export type { MCPClient } from "./adapters/ai-sdk.js";

export function createToolServer(server: import("./types.js").ToolServer): import("./types.js").ToolServer {
  return server;
}

