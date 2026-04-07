/**
 * MCP Redis Client Package
 * Browser/React client-side exports for MCP connection management
 */

/** SSE client for real-time connections */
export { SSEClient, type SSEClientOptions } from './core/sse-client';
export { AppHost } from './core/app-host';
export { LocalStorageBackend, type LocalStorageBackendOptions } from './storage/localstorage-backend.js';



/** Re-export shared types */
export type {
  McpConnectionEvent,
  McpConnectionState,
  McpObservabilityEvent,
  Emitter,
  Disposable,
  Event,
  DisposableStore,
} from '../shared/events';

export type {
  ToolInfo,
  McpRpcRequest,
  McpRpcResponse,
} from '../shared/types';
