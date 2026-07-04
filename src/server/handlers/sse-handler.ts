/**
 * SSE (Server-Sent Events) Handler for MCP Connections
 *
 * Manages real-time bidirectional communication with MCP clients:
 * - SSE stream for server → client events (connection state, tools, logs)
 * - HTTP POST for client → server RPC requests
 *
 * Key features:
 * - Direct HTTP response for RPC calls (bypasses SSE latency)
 * - Automatic session restoration and validation
 * - OAuth 2.1 authentication flow support
 * - Heartbeat to keep connections alive
 */

import type { McpConnectionEvent, McpObservabilityEvent } from '../../shared/events.js';
import type {
  McpRpcRequest,
  McpRpcResponse,
  ConnectParams,
  DisconnectParams,
  ReconnectParams,
  SessionParams,
  CallToolParams,
  GetPromptParams,
  ReadResourceParams,
  FinishAuthParams,
  SessionListResult,
  ConnectResult,
  DisconnectResult,
  GetSessionResult,
  FinishAuthResult,
  ListToolsRpcResult,
  ListPromptsResult,
  ListResourcesResult,
  CallToolResult,
  SetToolPolicyParams,
  SetToolPolicyResult,
  GetToolPolicyParams,
  GetToolPolicyResult,
} from '../../shared/types.js';
import { RpcErrorCodes } from '../../shared/errors.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { isConnectionEvent, isRpcResponseEvent } from '../../shared/event-routing.js';
import { parseOAuthState } from '../../shared/utils.js';
import { MCPClient } from '../mcp/oauth-client.js';
import { sessions, generateServerId, type Session } from '../storage/index.js';
import { createToolId, isToolAllowed, normalizeToolPolicyForUpdate, validateToolPolicyAgainstTools } from '../storage/tool-policy.js';
import { createToolPolicyGateway } from '../mcp/tool-policy-gateway.js';

// ============================================
// Types & Interfaces
// ============================================

export interface ClientMetadata {
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
  policyUri?: string;
}

export interface SSEHandlerOptions {
  /** User/Client identifier */
  userId: string;

  /** Optional callback for authentication/authorization */
  onAuth?: (userId: string) => Promise<boolean>;

  /** Heartbeat interval in milliseconds @default 30000 */
  heartbeatInterval?: number;

  /** Static OAuth client metadata defaults (for all connections) */
  clientDefaults?: ClientMetadata;

  /** Dynamic OAuth client metadata getter (per-request, useful for multi-tenant) */
  getClientMetadata?: (request?: unknown) => ClientMetadata | Promise<ClientMetadata>;
}

// ============================================
// Constants
// ============================================

const DEFAULT_HEARTBEAT_INTERVAL = 30000;

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;

  const entries = Object.entries(headers)
    .map(([key, value]) => [key.trim(), String(value).trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ============================================
// SSEConnectionManager Class
// ============================================

/**
 * Manages a single SSE connection and handles MCP operations.
 * Each instance corresponds to one connected browser client.
 */
export class SSEConnectionManager {
  private readonly userId: string;
  private readonly clients = new Map<string, MCPClient>();
  private heartbeatTimer?: NodeJS.Timeout;
  private isActive = true;

  constructor(
    private readonly options: SSEHandlerOptions,
    private readonly sendEvent: (event: McpConnectionEvent | McpObservabilityEvent | McpRpcResponse) => void
  ) {
    this.userId = options.userId;
    this.startHeartbeat();
  }

  /**
   * Get resolved client metadata (dynamic > static > defaults)
   */
  private async getResolvedClientMetadata(request?: any): Promise<ClientMetadata> {
    // Priority: getClientMetadata() > clientDefaults > empty object
    let metadata: ClientMetadata = {};

    // Start with static defaults
    if (this.options.clientDefaults) {
      metadata = { ...this.options.clientDefaults };
    }

    // Override with dynamic metadata if provided
    if (this.options.getClientMetadata) {
      const dynamicMetadata = await this.options.getClientMetadata(request);
      metadata = { ...metadata, ...dynamicMetadata };
    }

    return metadata;
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    const interval = this.options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimer = setInterval(() => {
      if (this.isActive) {
        this.sendEvent({
          level: 'debug',
          message: 'heartbeat',
          timestamp: Date.now(),
        } as McpObservabilityEvent);
      }
    }, interval);
  }

  /**
   * Handle incoming RPC requests
   * Returns the RPC response directly for immediate HTTP response (bypassing SSE latency)
   */
  async handleRequest(request: McpRpcRequest): Promise<McpRpcResponse> {
    try {
      let result: SessionListResult | ConnectResult | DisconnectResult | GetSessionResult | FinishAuthResult | ListToolsRpcResult | SetToolPolicyResult | GetToolPolicyResult | ListPromptsResult | ListResourcesResult | unknown;

      switch (request.method) {
        case 'listSessions':
          result = await this.listSessions();
          break;

        case 'connect':
          result = await this.connect(request.params as ConnectParams);
          break;

        case 'reconnect':
          result = await this.reconnect(request.params as ReconnectParams);
          break;

        case 'disconnect':
          result = await this.disconnect(request.params as DisconnectParams);
          break;

        case 'listTools':
          result = await this.listTools(request.params as SessionParams);
          break;

        case 'setToolPolicy':
          result = await this.setToolPolicy(request.params as SetToolPolicyParams);
          break;

        case 'getToolPolicy':
          result = await this.getToolPolicy(request.params as GetToolPolicyParams);
          break;

        case 'callTool':
          result = await this.callTool(request.params as CallToolParams);
          break;

        case 'getSession':
          result = await this.getSession(request.params as SessionParams);
          break;

        case 'finishAuth':
          result = await this.finishAuth(request.params as FinishAuthParams);
          break;

        case 'listPrompts':
          result = await this.listPrompts(request.params as SessionParams);
          break;

        case 'getPrompt':
          result = await this.getPrompt(request.params as GetPromptParams);
          break;

        case 'listResources':
          result = await this.listResources(request.params as SessionParams);
          break;

        case 'readResource':
          result = await this.readResource(request.params as ReadResourceParams);
          break;

        default:
          throw new Error(`Unknown method: ${request.method}`);
      }

      const response: McpRpcResponse = {
        id: request.id,
        result,
      };

      // Also send via SSE for backwards compatibility
      this.sendEvent(response);

      return response;
    } catch (error) {
      const errorResponse: McpRpcResponse = {
        id: request.id,
        error: {
          code: RpcErrorCodes.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };

      // Also send via SSE for backwards compatibility
      this.sendEvent(errorResponse);

      return errorResponse;
    }
  }

  /**
   * Get all sessions for the current userId
   */
  private async listSessions(): Promise<SessionListResult> {
    const sessionList = await sessions.list(this.userId);

    return {
      sessions: sessionList.map((s) => ({
        sessionId: s.sessionId,
        serverId: s.serverId,
        serverName: s.serverName,
        serverUrl: s.serverUrl,
        transport: s.transportType,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt ?? s.createdAt,
        status: s.status ?? 'pending',
        toolPolicy: s.toolPolicy,
      })),
    };
  }

  /**
   * Connect to an MCP server
   */
  private async connect(params: ConnectParams): Promise<ConnectResult> {
    const { serverName, serverUrl, callbackUrl, transportType } = params;
    const headers = normalizeHeaders(params.headers);

    // Normalize serverId to max 12 chars to keep tool names under 64 chars (DeepSeek/OpenAI limits)
    // Tool name format: tool_<serverId>_<toolName> - with 12 char serverId leaves 46 chars for tool name
    const serverId = params.serverId && params.serverId.length <= 12
      ? params.serverId
      : generateServerId();

    // Check for existing connections
    const existingSessions = await sessions.list(this.userId);
    const duplicate = existingSessions.find(s =>
      s.serverId === serverId || s.serverUrl === serverUrl
    );

    if (duplicate) {
      // If the existing session is still pending OAuth, treat connect as "resume auth"
      // instead of failing with duplicate connection error.
      if (duplicate.status === 'pending') {
        await this.getSession({ sessionId: duplicate.sessionId });
        return {
          sessionId: duplicate.sessionId,
          success: true,
        };
      }
      throw new Error(`Connection already exists for server: ${duplicate.serverUrl || duplicate.serverId} (${duplicate.serverName})`);
    }

    // Generate session ID
    const sessionId = await sessions.generateSessionId();

    try {
      // Get resolved client metadata
      const clientMetadata = await this.getResolvedClientMetadata();

      // Create MCP client
      const client = new MCPClient({
        userId: this.userId,
        sessionId,
        serverId,
        serverName,
        serverUrl,
        callbackUrl,
        transportType,
        headers,
        ...clientMetadata, // Spread client metadata (clientName, clientUri, logoUri, policyUri)
      });

      // Note: Session will be created by MCPClient after successful connection
      // This ensures sessions only exist for successful or OAuth-pending connections

      // Store client
      this.clients.set(sessionId, client);

      // Subscribe to client events
      client.onConnectionEvent((event) => {
        this.emitConnectionEvent(event);
      });

      client.onObservabilityEvent((event) => {
        this.sendEvent(event);
      });

      // Attempt connection
      await client.connect();

      // Fetch policy-filtered tools for agent-facing discovery
      await this.listPolicyFilteredTools(sessionId);

      return {
        sessionId,
        success: true,
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        // OAuth-required is a pending-auth state, not a failed connection.
        this.clients.delete(sessionId);
        return {
          sessionId,
          success: true,
        };
      }

      this.emitConnectionEvent({
        type: 'error',
        sessionId,
        serverId,
        error: error instanceof Error ? error.message : 'Connection failed',
        errorType: 'connection',
        timestamp: Date.now(),
      });

      // Clean up client
      this.clients.delete(sessionId);

      throw error;
    }
  }

  /**
   * Reconnect to an MCP server — tears down the active client transport/connection
   * and creates a fresh connection while reusing the existing session credentials in a single RPC call.
   */
  private async reconnect(params: ReconnectParams): Promise<ConnectResult> {
    const { serverId: rawServerId, serverName, serverUrl, callbackUrl, transportType } = params;
    const headers = normalizeHeaders(params.headers);

    // Normalize serverId the same way connect() does
    const serverId = rawServerId && rawServerId.length <= 12
      ? rawServerId
      : generateServerId();

    // Find existing session for the same server to reuse its session ID
    const existingSessions = await sessions.list(this.userId);
    const duplicate = existingSessions.find(s =>
      s.serverId === serverId || s.serverUrl === serverUrl
    );

    // Reuse the duplicate sessionId if present, otherwise generate a new one
    const sessionId = duplicate ? duplicate.sessionId : await sessions.generateSessionId();

    if (duplicate) {
      // Disconnect any active in-memory client transport without deleting the database session
      const existingClient = this.clients.get(duplicate.sessionId);
      if (existingClient) {
        await existingClient.disconnect();
        this.clients.delete(duplicate.sessionId);
      }
    }

    try {
      const clientMetadata = await this.getResolvedClientMetadata();

      // Create a new client instantiating the reused session ID (which preserves DCR credentials and tokens)
      const client = new MCPClient({
        userId: this.userId,
        sessionId,
        serverId,
        serverName,
        serverUrl,
        callbackUrl,
        transportType,
        headers,
        ...clientMetadata,
      });

      this.clients.set(sessionId, client);

      client.onConnectionEvent((event) => {
        this.emitConnectionEvent(event);
      });

      client.onObservabilityEvent((event) => {
        this.sendEvent(event);
      });

      await client.connect();
      await this.listPolicyFilteredTools(sessionId);

      return { sessionId, success: true };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.clients.delete(sessionId);
        return { sessionId, success: true };
      }

      this.emitConnectionEvent({
        type: 'error',
        sessionId,
        serverId,
        error: error instanceof Error ? error.message : 'Connection failed',
        errorType: 'connection',
        timestamp: Date.now(),
      });

      this.clients.delete(sessionId);
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  private async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    const { sessionId } = params;
    const client = this.clients.get(sessionId);

    if (client) {
      // clearSession() handles DELETE + local cleanup internally.
      await client.clearSession();
      this.clients.delete(sessionId);
    } else {
      // Handle orphaned sessions (e.g., OAuth flow failed before client was stored)
      // Directly remove from storage since there's no active client
      await sessions.delete(this.userId, sessionId);
    }

    return { success: true };
  }

  /**
   * Get an existing client or create and connect a new one for the session.
   */
  private async getOrCreateClient(sessionId: string): Promise<MCPClient> {
    const existing = this.clients.get(sessionId);
    if (existing) {
      return existing;
    }

    const session = await sessions.get(this.userId, sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Load credentials so we can rehydrate clientId/clientSecret.
    // Session rows do NOT store these — they live in SessionCredentials.
    const creds = await sessions.getCredentials(this.userId, sessionId);
    const clientId = creds?.clientId ?? undefined;
    const clientSecret = (creds?.clientInformation as any)?.client_secret ?? undefined;

    const client = new MCPClient({
      userId: this.userId,
      sessionId,
      serverId: session.serverId,
      serverName: session.serverName,
      serverUrl: session.serverUrl,
      callbackUrl: session.callbackUrl,
      transportType: session.transportType,
      headers: session.headers,
      clientId,
      clientSecret,
    });

    // Subscribe to events before connecting
    client.onConnectionEvent((event) => this.emitConnectionEvent(event));
    client.onObservabilityEvent((event) => this.sendEvent(event));

    await client.connect();
    this.clients.set(sessionId, client);

    return client;
  }

  /**
   * Fetches all tools from the remote MCP server and emits a `tools_discovered` event.
   *
   * Two lists are always published together:
   * - `tools`    — policy-filtered list that agents are allowed to call.
   * - `allTools` — the complete, unfiltered list used by the management UI so
   *                that blocked tools still appear as checkboxes in the dialog.
   *
   * `fetchTools()` is called first (populates the in-memory cache), then
   * `gateway.listTools()` re-uses that cache internally — so only one remote
   * network round-trip is made regardless of how many callers follow.
   *
   * @param sessionId - The session whose tools should be discovered.
   * @returns The session record and the policy-filtered tool list.
   * @throws {Error} When the session does not exist in the store.
   */
  private async listPolicyFilteredTools(sessionId: string): Promise<{ session: Session; result: ListToolsRpcResult }> {
    const session = await sessions.get(this.userId, sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const client = await this.getOrCreateClient(sessionId);
    const allTools = await client.fetchTools().catch(() => ({ tools: [] }));
    const gateway = createToolPolicyGateway(this.userId, sessionId, client);
    const result = await gateway.listTools();

    this.emitConnectionEvent({
      type: 'tools_discovered',
      sessionId,
      serverId: session.serverId ?? 'unknown',
      toolCount: result.tools.length,
      tools: result.tools,
      allTools: allTools.tools,
      timestamp: Date.now(),
    });

    return { session, result };
  }

  /**
   * Returns the policy-filtered tool list for a session (agent-facing).
   * Internally re-uses `listPolicyFilteredTools` which also emits a
   * `tools_discovered` SSE event to keep client state up to date.
   */
  private async listTools(params: SessionParams): Promise<ListToolsRpcResult> {
    const { sessionId } = params;
    const { result } = await this.listPolicyFilteredTools(sessionId);
    return { tools: result.tools };
  }

  /**
   * Get all raw tools with effective access state for management UI.
   */
  private async getToolPolicy(params: GetToolPolicyParams): Promise<GetToolPolicyResult> {
    const { sessionId } = params;
    const session = await sessions.get(this.userId, sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const client = await this.getOrCreateClient(sessionId);
    const allTools = await client.fetchTools();
    const toolPolicy = session.toolPolicy ?? {
      mode: 'all' as const,
      toolIds: [],
      updatedAt: session.updatedAt ?? session.createdAt,
    };
    const serverId = session.serverId ?? 'unknown';
    const tools = allTools.tools.map((tool) => ({
      ...tool,
      toolId: createToolId(serverId, tool.name),
      allowed: isToolAllowed(toolPolicy, tool.name, session.serverId),
    }));

    return {
      toolPolicy,
      tools,
      toolCount: tools.length,
      allowedToolCount: tools.filter((tool) => tool.allowed).length,
    };
  }

  /**
   * Persists a new tool access policy for a session and broadcasts the updated
   * filtered tool list to all connected browser clients via a `tools_discovered` event.
   *
   * Both `tools` (policy-filtered) and `allTools` (complete list) are emitted
   * so the management UI can immediately reflect the new checkbox states without
   * an additional round-trip to the server.
   *
   * @param params - Session ID and the new `{ mode, toolIds }` policy to apply.
   * @throws {Error} When the session does not exist or the policy references unknown tool IDs.
   */
  private async setToolPolicy(params: SetToolPolicyParams): Promise<SetToolPolicyResult> {
    const { sessionId } = params;
    const session = await sessions.get(this.userId, sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const client = await this.getOrCreateClient(sessionId);
    const allTools = await client.fetchTools();
    const toolPolicy = normalizeToolPolicyForUpdate(params.toolPolicy);
    validateToolPolicyAgainstTools(toolPolicy, allTools.tools, session.serverId);

    await sessions.update(this.userId, sessionId, { toolPolicy });

    const filteredTools = createToolPolicyGateway(this.userId, sessionId, client).filterTools({ ...session, toolPolicy }, allTools.tools);
    this.emitConnectionEvent({
      type: 'tools_discovered',
      sessionId,
      serverId: session.serverId ?? 'unknown',
      toolCount: filteredTools.length,
      tools: filteredTools,
      allTools: allTools.tools,
      timestamp: Date.now(),
    });

    return {
      success: true,
      toolPolicy,
      tools: filteredTools,
      toolCount: filteredTools.length,
    };
  }

  /**
   * Proxies a tool invocation to the remote MCP server.
   * Resolves the client for the given session and delegates to the tool router.
   */
  private async callTool(params: CallToolParams): Promise<CallToolResult> {
    const { sessionId, toolName, toolArgs } = params;
    const client = await this.getOrCreateClient(sessionId);
    const result = await createToolPolicyGateway(this.userId, sessionId, client).callTool(toolName, toolArgs);

    // Inject sessionId into meta so client knows who handled it
    // This allows AppHost to auto-launch without scanning all sessions
    const meta = result._meta || {};

    return {
      ...result,
      _meta: {
        ...meta,
        sessionId,
      }
    };
  }

  /**
   * Restore and validate an existing session
   */
  private async getSession(params: SessionParams): Promise<GetSessionResult> {
    const { sessionId } = params;

    const session = await sessions.get(this.userId, sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    this.emitConnectionEvent({
      type: 'state_changed',
      sessionId,
      serverId: session.serverId ?? 'unknown',
      serverName: session.serverName ?? 'Unknown',
      serverUrl: session.serverUrl,
      state: 'VALIDATING',
      previousState: 'DISCONNECTED',
      timestamp: Date.now(),
    });

    try {
      const clientMetadata = await this.getResolvedClientMetadata();

      // Load credentials to rehydrate clientId/clientSecret for session restore.
      const creds = await sessions.getCredentials(this.userId, sessionId);
      const clientId = creds?.clientId ?? undefined;
      const clientSecret = (creds?.clientInformation as any)?.client_secret ?? undefined;

      const client = new MCPClient({
        userId: this.userId,
        sessionId,
        serverId: session.serverId,
        serverName: session.serverName,
        serverUrl: session.serverUrl,
        callbackUrl: session.callbackUrl,
        transportType: session.transportType,
        headers: session.headers,
        clientId,
        clientSecret,
        ...clientMetadata,
      });

      client.onConnectionEvent((event) => this.emitConnectionEvent(event));
      client.onObservabilityEvent((event) => this.sendEvent(event));

      await client.connect();
      this.clients.set(sessionId, client);

      const { result: tools } = await this.listPolicyFilteredTools(sessionId);

      return { success: true, toolCount: tools.tools.length };
    } catch (error) {
      this.emitConnectionEvent({
        type: 'error',
        sessionId,
        serverId: session.serverId ?? 'unknown',
        error: error instanceof Error ? error.message : 'Validation failed',
        errorType: 'validation',
        timestamp: Date.now(),
      });

      throw error;
    }
  }

  /**
   * Complete OAuth authorization flow
   */
  private async finishAuth(params: FinishAuthParams): Promise<FinishAuthResult> {
    const { code } = params;
    const oauthState = params.state;
    const parsedState = parseOAuthState(oauthState);
    const sessionId = parsedState?.sessionId || oauthState;

    const session = await sessions.get(this.userId, sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    try {
      // Load credentials to rehydrate clientId/clientSecret.
      // This is critical for pre-registered OAuth clients (clientId/clientSecret)
      // where the secret must be passed during token exchange.
      const creds = await sessions.getCredentials(this.userId, sessionId);
      const clientId = creds?.clientId ?? undefined;
      const clientSecret = (creds?.clientInformation as any)?.client_secret ?? undefined;

      const client = new MCPClient({
        userId: this.userId,
        sessionId,
        serverId: session.serverId,
        serverName: session.serverName,
        serverUrl: session.serverUrl,
        callbackUrl: session.callbackUrl,
        // NOTE: transportType is intentionally omitted here.
        // The session's stored transportType is a placeholder ('streamable-http')
        // set before transport negotiation. Omitting it lets MCPClient auto-negotiate
        // (try streamable_http → SSE fallback), which is critical for servers like
        // Neon that only support SSE transport.
        headers: session.headers,
        clientId,
        clientSecret,
      });

      client.onConnectionEvent((event) => this.emitConnectionEvent(event));

      await client.finishAuth(code, oauthState);
      this.clients.set(sessionId, client);

      const { result: tools } = await this.listPolicyFilteredTools(sessionId);

      return { success: true, toolCount: tools.tools.length };
    } catch (error) {
      this.emitConnectionEvent({
        type: 'error',
        sessionId,
        serverId: session.serverId ?? 'unknown',
        error: error instanceof Error ? error.message : 'OAuth completion failed',
        errorType: 'auth',
        timestamp: Date.now(),
      });

      throw error;
    }
  }

  /**
   * List prompts from a session
   */
  private async listPrompts(params: SessionParams): Promise<ListPromptsResult> {
    const { sessionId } = params;
    const client = await this.getOrCreateClient(sessionId);
    const result = await client.listPrompts();
    return { prompts: result.prompts };
  }

  /**
   * Get a specific prompt
   */
  private async getPrompt(params: GetPromptParams): Promise<unknown> {
    const { sessionId, name, args } = params;
    const client = await this.getOrCreateClient(sessionId);
    return await client.getPrompt(name, args);
  }

  /**
   * List resources from a session
   */
  private async listResources(params: SessionParams): Promise<ListResourcesResult> {
    const { sessionId } = params;
    const client = await this.getOrCreateClient(sessionId);
    const result = await client.listResources();
    return { resources: result.resources };
  }

  /**
   * Read a specific resource
   */
  private async readResource(params: ReadResourceParams): Promise<unknown> {
    const { sessionId, uri } = params;
    const client = await this.getOrCreateClient(sessionId);
    return client.readResource(uri);
  }

  /**
   * Emit connection event
   */
  private emitConnectionEvent(event: McpConnectionEvent): void {
    this.sendEvent(event);
  }

  /**
   * Cleanup and close all connections
   */
  async dispose(): Promise<void> {
    this.isActive = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Send HTTP DELETE to each Streamable HTTP server before closing, per spec.
    // Run in parallel so shutdown is not serialised across many sessions.
    await Promise.all(
      Array.from(this.clients.values()).map((client) => client.disconnect())
    );

    this.clients.clear();
  }
}

// ============================================
// SSE Handler Factory
// ============================================

/**
 * Create an SSE endpoint handler compatible with Node.js HTTP frameworks.
 * Handles both SSE streaming (GET) and RPC requests (POST).
 */
export function createSSEHandler(options: SSEHandlerOptions) {
  return async (req: { method?: string; on: Function }, res: { writeHead: Function; write: Function }) => {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial connection acknowledgment
    writeSSEEvent(res, 'connected', { timestamp: Date.now() });

    // Create connection manager with event routing
    const manager = new SSEConnectionManager(options, (event) => {
      if (isRpcResponseEvent(event)) {
        writeSSEEvent(res, 'rpc-response', event);
      } else if (isConnectionEvent(event)) {
        writeSSEEvent(res, 'connection', event);
      } else {
        writeSSEEvent(res, 'observability', event);
      }
    });

    // Cleanup on client disconnect
    req.on('close', () => manager.dispose());

    // Handle RPC requests via POST
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const request: McpRpcRequest = JSON.parse(body);
          await manager.handleRequest(request);
        } catch {
          // Request parsing/handling errors are sent via SSE error events
        }
      });
    }
  };
}

// ============================================
// Utilities
// ============================================

/**
 * Write an SSE event to the response stream
 */
function writeSSEEvent(res: { write: Function }, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}






