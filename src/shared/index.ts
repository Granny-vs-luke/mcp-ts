/**
 * MCP Redis Shared Package
 * Shared types and utilities for both server and client
 */

// Events
export {
  Emitter,
  DisposableStore,
  type Disposable,
  type Event,
  type McpConnectionState,
  type McpConnectionEvent,
  type McpElicitationEvent,
  type McpObservabilityEvent,
} from './events';

// Constants
export * from './constants';

// Errors
export * from './errors';

// Types
export type {
  ToolClient,
  ToolClientProvider,
  ToolInfo,
  McpRpcRequest,
  McpRpcResponse,
  McpRpcMethod,
  McpRpcParams,
  TransportType,
  // API types
  ConnectRequest,
  ConnectResponse,
  ConnectSuccessResponse,
  ConnectAuthRequiredResponse,
  ConnectErrorResponse,
  ListToolsResponse,
  CallToolRequest,
  CallToolResponse,
  // RPC param types
  ConnectParams,
  DisconnectParams,
  SessionParams,
  CallToolParams,
  GetPromptParams,
  ReadResourceParams,
  FinishAuthParams,
  ElicitRespondParams,
  // RPC result types
  SessionInfo,
  SessionListResult,
  ConnectResult,
  DisconnectResult,
  RestoreSessionResult,
  FinishAuthResult,
  ElicitRespondResult,
  ListToolsRpcResult,
  ListPromptsResult,
  ListResourcesResult,
} from './types';

export {
  isConnectSuccess,
  isConnectAuthRequired,
  isConnectError,
  isListToolsSuccess,
  isCallToolSuccess,
} from './types';

// Utilities
export { sanitizeServerLabel } from './utils.js';
export {
  getToolUiResourceUri,
  findToolByName,
  type ToolUiConfig,
} from './tool-utils.js';

// Tool Router — Context window optimization
export {
  ToolRouter,
  type ToolRouterOptions,
  type ToolRouterStrategy,
  type ToolRouterClientInput,
  type ToolGroupInfo,
} from './tool-router.js';

export {
  ToolIndex,
  type ToolSummary,
  type IndexedTool,
  type ToolIndexOptions,
  type EmbedFn,
} from './tool-index.js';

export {
  SchemaCompressor,
  type CompactTool,
  type CompressionStats,
} from './schema-compressor.js';

export {
  createSearchToolDefinition,
  createRegexSearchToolDefinition,
  createGetSchemaToolDefinition,
  createExecuteToolDefinition,
  executeMetaTool,
  isMetaTool,
  resolveMetaToolProxy,
  type CallToolFn,
} from './meta-tools.js';

