export { ToolRouter, createToolRouter } from "./router.js";
export {
  createMetaTools,
  DEFAULT_TOOLROUTER_META_TOOL_NAMES
} from "./meta-tools.js";
export { createAISDKTools, asToolSource } from "./adapters/ai-sdk.js";
export { mcpSource, mcpSources } from "./adapters/mcp.js";
export { BM25SearchStrategy } from "./search.js";
export { PolicyEnforcer } from "./policy.js";
export type {
  IndexedTool,
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
  ToolSource
} from "./types.js";
export type { MCPClient } from "./adapters/ai-sdk.js";

export function createToolSource(source: import("./types.js").ToolSource): import("./types.js").ToolSource {
  return source;
}
