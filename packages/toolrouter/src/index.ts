export { ToolRouter, createToolRouter } from "./router.js";
export {
  TOOLROUTER_CALL_TOOL,
  TOOLROUTER_GET_TOOL_SCHEMA,
  TOOLROUTER_LIST_SOURCES,
  TOOLROUTER_META_TOOL_NAMES,
  TOOLROUTER_SEARCH_TOOLS,
  createMetaTools,
  isToolRouterMetaTool
} from "./meta-tools.js";
export { createAISDKTools } from "./adapters/ai-sdk.js";
export { mcpSource, mcpSources } from "./adapters/mcp.js";
export type {
  IndexedTool,
  ToolAnnotations,
  ToolCallRequest,
  ToolDefinition,
  ToolRouterCallResult,
  ToolRouterMetaTool,
  ToolRouterOptions,
  ToolRouterPolicy,
  ToolSchemaRequest,
  ToolSearchRequest,
  ToolSearchResult,
  ToolSource
} from "./types.js";

export function createToolSource(source: import("./types.js").ToolSource): import("./types.js").ToolSource {
  return source;
}
