import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { nanoid } from 'nanoid';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  UnauthorizedError as SDKUnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  ListToolsRequest,
  ListToolsResult,
  ListToolsResultSchema,
  CallToolRequest,
  CallToolResult,
  CallToolResultSchema,
  ListPromptsRequest,
  ListPromptsResult,
  ListPromptsResultSchema,
  GetPromptRequest,
  GetPromptResult,
  GetPromptResultSchema,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourcesResultSchema,
  ReadResourceRequest,
  ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StorageOAuthClientProvider, type AgentsOAuthProvider } from './storage-oauth-provider.js';
import { sanitizeServerLabel } from '../../shared/utils.js';
import { Emitter, type McpConnectionEvent, type McpObservabilityEvent, type McpConnectionState } from '../../shared/events.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { sessions } from '../storage/index.js';
import {
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  SESSION_TTL_SECONDS,
  STATE_EXPIRATION_MS,
} from '../../shared/constants.js';

/**
 * Supported MCP transport types
 */
export type TransportType = 'sse' | 'streamable-http';

/**
 * Extended capabilities including MCP App support
 */
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

interface McpAppClientCapabilities extends Omit<ClientCapabilities, 'extensions'> {
  extensions?: {
    'io.modelcontextprotocol/ui'?: {
      mimeTypes: string[];
    };
    [key: string]: any;
  };
}

export interface MCPOAuthClientOptions {
  serverUrl?: string;
  serverName?: string;
  callbackUrl?: string;
  onRedirect?: (url: string) => void;
  userId: string;
  serverId?: string; /** Optional - loaded from session if not provided */
  sessionId: string; /** Required - primary key for session lookup */
  transportType?: TransportType;
  clientId?: string;
  clientSecret?: string;
  headers?: Record<string, string>;
  /** OAuth Client Metadata (optional - user application info) */
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
  policyUri?: string;
}

/**
 * MCP Client with OAuth 2.1 authentication support
 * Manages connections to MCP servers with automatic token refresh and session restoration
 * Emits connection lifecycle events for observability
 */
export class MCPClient {
  private client: Client | null = null;
  public oauthProvider: AgentsOAuthProvider | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private userId: string;
  private serverId?: string;
  private sessionId: string;
  private serverName?: string;
  private transportType: TransportType | undefined;
  private serverUrl: string | undefined;
  private callbackUrl: string | undefined;
  private onRedirect: ((url: string) => void) | undefined;
  private clientId?: string;
  private clientSecret?: string;
  private headers?: Record<string, string>;
  /** OAuth Client Metadata */
  private clientName?: string;
  private clientUri?: string;
  private logoUri?: string;
  private policyUri?: string;
  private createdAt?: number;


  /** Event emitters for connection lifecycle */
  private readonly _onConnectionEvent = new Emitter<McpConnectionEvent>();
  public readonly onConnectionEvent = this._onConnectionEvent.event;

  private readonly _onObservabilityEvent = new Emitter<McpObservabilityEvent>();
  public readonly onObservabilityEvent = this._onObservabilityEvent.event;

  private currentState: McpConnectionState = 'DISCONNECTED';

  /**
   * Creates a new MCP client instance
   * Can be initialized with minimal options (userId + sessionId) for session restoration
   * @param options - Client configuration options
   */
  constructor(options: MCPOAuthClientOptions) {
    this.serverUrl = options.serverUrl;
    this.serverName = options.serverName;
    this.callbackUrl = options.callbackUrl;
    this.onRedirect = options.onRedirect;
    this.userId = options.userId;
    this.serverId = options.serverId;
    this.sessionId = options.sessionId;
    this.transportType = options.transportType;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.headers = options.headers;
    this.clientName = options.clientName;
    this.clientUri = options.clientUri;
    this.logoUri = options.logoUri;
    this.policyUri = options.policyUri;
  }

  /**
   * Emit a connection state change event
   * @private
   */
  private emitStateChange(newState: McpConnectionState): void {
    const previousState = this.currentState;
    this.currentState = newState;

    if (!this.serverId) return;

    this._onConnectionEvent.fire({
      type: 'state_changed',
      sessionId: this.sessionId,
      serverId: this.serverId,
      serverName: this.serverName || this.serverId,
      serverUrl: this.serverUrl || '',
      createdAt: this.createdAt,
      state: newState,
      previousState,
      timestamp: Date.now(),
    });

    this._onObservabilityEvent.fire({
      type: 'mcp:client:state_change',
      level: 'info',
      message: `Connection state: ${previousState} → ${newState}`,
      displayMessage: `State changed to ${newState}`,
      sessionId: this.sessionId,
      serverId: this.serverId,
      payload: { previousState, newState },
      timestamp: Date.now(),
      id: nanoid(),
    });
  }

  /**
   * Emit an error event
   * @private
   */
  private emitError(error: string, errorType: 'connection' | 'auth' | 'validation' | 'unknown' = 'unknown'): void {
    if (!this.serverId) return;

    this._onConnectionEvent.fire({
      type: 'error',
      sessionId: this.sessionId,
      serverId: this.serverId,
      error,
      errorType,
      timestamp: Date.now(),
    });

    this._onObservabilityEvent.fire({
      type: 'mcp:client:error',
      level: 'error',
      message: error,
      displayMessage: error,
      sessionId: this.sessionId,
      serverId: this.serverId,
      payload: { errorType, error },
      timestamp: Date.now(),
      id: nanoid(),
    });
  }

  /**
   * Emit a progress event
   * @private
   */
  private emitProgress(message: string): void {
    if (!this.serverId) return;

    this._onConnectionEvent.fire({
      type: 'progress',
      sessionId: this.sessionId,
      serverId: this.serverId,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Get current connection state
   */
  getConnectionState(): McpConnectionState {
    return this.currentState;
  }

  /**
   * Helper to create a transport instance
   * @param type - The transport type to create
   * @returns Configured transport instance
   * @private
   */
  private getTransport(type: TransportType): StreamableHTTPClientTransport | SSEClientTransport {
    if (!this.serverUrl) {
      throw new Error('Server URL is required to create transport');
    }

    const baseUrl = new URL(this.serverUrl);
    const hasAuthorizationHeader = Object.keys(this.headers || {})
      .some((key) => key.toLowerCase() === 'authorization');
    const transportOptions = {
      ...(!hasAuthorizationHeader && { authProvider: this.oauthProvider! }),
      ...(this.headers && { requestInit: { headers: this.headers } }),
      /**
       * Custom fetch implementation to handle connection timeouts.
       * Observation: SDK 1.24.0+ connections may hang indefinitely in some environments.
       * This wrapper enforces a timeout and properly uses AbortController to unblock the request.
       */
      fetch: (url: RequestInfo | URL, init?: RequestInit) => {
        const timeout = 30000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const signal = init?.signal ?
          // @ts-ignore: AbortSignal.any is available in Node 20+
          (AbortSignal.any ? AbortSignal.any([init.signal, controller.signal]) : controller.signal) :
          controller.signal;

        return fetch(url, { ...init, signal }).finally(() => clearTimeout(timeoutId));
      }
    };

    if (type === 'sse') {
      return new SSEClientTransport(baseUrl, transportOptions);
    } else {
      return new StreamableHTTPClientTransport(baseUrl, transportOptions);
    }
  }

  /**
   * Initializes client components (client, transport, OAuth provider)
   * Loads missing configuration from Redis session store if needed
   * This method is idempotent and safe to call multiple times
   * @private
   */
  private async initialize(): Promise<void> {
    if (this.client && this.oauthProvider) {
      return;
    }

    this.emitStateChange('INITIALIZING');
    this.emitProgress('Loading session configuration...');

    if (!this.serverUrl || !this.callbackUrl || !this.serverId) {
      const sessionData = await sessions.get(this.userId, this.sessionId);
      if (!sessionData) {
        throw new Error(`Session not found: ${this.sessionId}`);
      }

      this.serverUrl = this.serverUrl || sessionData.serverUrl;
      this.callbackUrl = this.callbackUrl || sessionData.callbackUrl;
      /**
       * Do NOT load transportType from session if not explicitly provided.
       * We want to re-negotiate (try streamable -> sse) on new connections if in "Auto" mode.
       * this.transportType = this.transportType || sessionData.transportType; 
       */
      this.serverName = this.serverName || sessionData.serverName;
      this.serverId = this.serverId || sessionData.serverId || 'unknown';
      this.headers = this.headers || sessionData.headers;
      this.createdAt = sessionData.createdAt;
    }

    if (!this.serverUrl || !this.callbackUrl || !this.serverId) {
      throw new Error('Missing required connection metadata');
    }

    if (!this.oauthProvider) {
      if (!this.serverId) {
        throw new Error('serverId required for OAuth provider initialization');
      }
      this.oauthProvider = new StorageOAuthClientProvider({
        userId: this.userId,
        serverId: this.serverId,
        sessionId: this.sessionId,
        redirectUrl: this.callbackUrl!,
        clientName: this.clientName,
        clientUri: this.clientUri,
        logoUri: this.logoUri,
        policyUri: this.policyUri,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        onRedirect: (redirectUrl: string) => {
          if (this.onRedirect) {
            this.onRedirect(redirectUrl);
          }
        }
      });
    }

    if (!this.client) {
      this.client = new Client(
        {
          name: MCP_CLIENT_NAME,
          version: MCP_CLIENT_VERSION,
        },
        {
          capabilities: {
            extensions: {
              'io.modelcontextprotocol/ui': {
                mimeTypes: ['text/html+mcp'],
              },
            },
          } as McpAppClientCapabilities
        }
      );
    }

    // Create session in the session store if it doesn't exist yet
    // This is needed BEFORE OAuth flow starts because the OAuth provider
    // will call saveCodeVerifier() which requires the session to exist
    const existingSession = await sessions.get(this.userId, this.sessionId);
    if (!existingSession && this.serverId && this.serverUrl && this.callbackUrl) {
      this.createdAt = Date.now();
      console.log(`[MCPClient] Creating initial session ${this.sessionId} for OAuth flow`);
      await sessions.create({
        sessionId: this.sessionId,
        userId: this.userId,
        serverId: this.serverId,
        serverName: this.serverName,
        serverUrl: this.serverUrl,
        callbackUrl: this.callbackUrl,
        transportType: this.transportType || 'streamable-http',
        headers: this.headers,
        createdAt: this.createdAt,
        active: false,
      }, Math.floor(STATE_EXPIRATION_MS / 1000)); // Short TTL until connection succeeds
    }
  }

  /**
   * Saves current session state to the session store
   * Creates new session if it doesn't exist, updates if it does
   * @param ttl - Time-to-live in seconds (defaults to 12hr for connected sessions)
   * @param active - Session status marker used to avoid unnecessary TTL rewrites
   * @private
   */
  private async saveSession(
    ttl: number = SESSION_TTL_SECONDS,
    active: boolean = true
  ): Promise<void> {
    if (!this.sessionId || !this.serverId || !this.serverUrl || !this.callbackUrl) {
      return;
    }

    const sessionData = {
      sessionId: this.sessionId,
      userId: this.userId,
      serverId: this.serverId,
      serverName: this.serverName,
      serverUrl: this.serverUrl,
      callbackUrl: this.callbackUrl,
      transportType: (this.transportType || 'streamable-http') as TransportType,
      headers: this.headers,
      createdAt: this.createdAt || Date.now(),
      active,
    };
    if (active) {
      (sessionData as typeof sessionData & { authUrl: null }).authUrl = null;
    }

    // Try to update first, create if doesn't exist
    const existingSession = await sessions.get(this.userId, this.sessionId);
    if (existingSession) {
      await sessions.update(this.userId, this.sessionId, sessionData, ttl);
    } else {
      await sessions.create(sessionData, ttl);
    }
  }

  /**
   * Try to connect using available transports
   * @returns The corrected transport type object if successful
   * @private
   */
  private async tryConnect(): Promise<{ transportType: TransportType }> {
    /**
     * If exact transport type is known, only try that.
     * Otherwise (auto mode), try streamable_http first, then sse.
     */
    const transportsToTry: TransportType[] = this.transportType
      ? [this.transportType]
      : ['streamable-http', 'sse'];

    let lastError: unknown;

    for (const currentType of transportsToTry) {
      const isLastAttempt = currentType === transportsToTry[transportsToTry.length - 1];

      try {
        const transport = this.getTransport(currentType);

        /** Update local state with the transport we are about to try */
        this.transport = transport;

        /** Race connection against timeout */
        await this.client!.connect(transport);

        /** Success! Return the type that worked */
        return { transportType: currentType };

      } catch (error: any) {
        lastError = error;

        /** Check for Auth Errors - these should fail immediately, no fallback */
        const isAuthError = error instanceof SDKUnauthorizedError ||
          (error instanceof Error && error.message.toLowerCase().includes('unauthorized'));

        if (isAuthError) {
          throw error;
        }

        /** If this was the last transport to try, throw the error */
        if (isLastAttempt) {
          throw error;
        }

        /** Otherwise, log and continue to next transport */
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.emitProgress(`Connection attempt with ${currentType} failed: ${errorMessage}. Retrying...`);
        this._onObservabilityEvent.fire({
          level: 'warn',
          message: `Transport ${currentType} failed, falling back`,
          sessionId: this.sessionId,
          serverId: this.serverId,
          metadata: {
            failedTransport: currentType,
            error: errorMessage
          },
          timestamp: Date.now(),
        });
      }
    }

    throw lastError || new Error('No transports available');
  }

  /**
   * Connects to the MCP server
   * Automatically validates and refreshes OAuth tokens if needed
   * Saves session to Redis on first successful connection
   * @throws {UnauthorizedError} When OAuth authorization is required
   * @throws {Error} When connection fails for other reasons
   */
  async connect(): Promise<void> {
    await this.initialize();

    if (!this.client || !this.oauthProvider) {
      const error = 'Client or OAuth provider not initialized';
      this.emitError(error, 'connection');
      this.emitStateChange('FAILED');
      throw new Error(error);
    }

    try {
      this.emitStateChange('CONNECTING');

      /** Use the tryConnect loop to handle transport fallbacks */
      const { transportType } = await this.tryConnect();

      /** Update transport type to the one that actually worked */
      this.transportType = transportType;

      this.emitStateChange('CONNECTED');
      this.emitProgress('Connected successfully');

      // Refresh session metadata on every successful connect so active sessions
      // record ongoing usage and don't look dormant to session cleanup jobs.
      console.log(`[MCPClient] Saving session ${this.sessionId} with 12hr TTL (connect success)`);
      await this.saveSession(SESSION_TTL_SECONDS, true);
    } catch (error) {
      /** Handle Authentication Errors */
      if (
        error instanceof SDKUnauthorizedError ||
        (error instanceof Error && error.message.toLowerCase().includes('unauthorized'))
      ) {
        /** Set when the SDK calls redirectToAuthorization on the OAuth provider */
        let authUrl = '';
        if (this.oauthProvider) {
          authUrl = (this.oauthProvider.authUrl || '').trim();
        }

        /**
         * 401 without a usable URL means metadata/DCR failed or the server never started
         * an interactive OAuth flow — not recoverable as "pending OAuth".
         */
        if (!authUrl) {
          const detail =
            error instanceof Error && error.message.trim().length > 0
              ? error.message.trim()
              : 'Unauthorized';
          const message =
            detail.toLowerCase() === 'unauthorized'
              ? 'OAuth authorization URL not available'
              : `OAuth authorization URL not available: ${detail}`;
          this.emitError(message, 'auth');
          this.emitStateChange('FAILED');
          
          // Proactive Cleanup: This session has reached a terminal failure state. 
          // We remove it now to ensure the database remains lean, bypassing the 
          // automated lifecycle sweep.
          try {
            await sessions.delete(this.userId, this.sessionId);
          } catch {
            // Non-blocking: Proactive cleanup failures are suppressed to prioritize 
            // the original error context.
          }
          
          throw new Error(message);
        }

        this.emitStateChange('AUTHENTICATING');
        // Save session with 10min TTL for OAuth pending state
        console.log(`[MCPClient] Saving session ${this.sessionId} with 10min TTL (OAuth pending)`);
        await this.saveSession(Math.floor(STATE_EXPIRATION_MS / 1000), false);

        if (this.serverId) {
          this._onConnectionEvent.fire({
            type: 'auth_required',
            sessionId: this.sessionId,
            serverId: this.serverId,
            authUrl,
            timestamp: Date.now(),
          });

          if (authUrl && this.onRedirect) {
            this.onRedirect(authUrl);
          }
        }

        throw new UnauthorizedError('OAuth authorization required');
      }

      /** Handle Generic Errors */
      const errorMessage = error instanceof Error ? error.message : 'Connection failed';
      this.emitError(errorMessage, 'connection');
      this.emitStateChange('FAILED');

      // Terminal Handshake Failure: only purge transient sessions. Active
      // sessions may still hold valid credentials for a later reconnect.
      try {
        const existingSession = await sessions.get(this.userId, this.sessionId);
        if (!existingSession || existingSession.active !== true) {
          await sessions.delete(this.userId, this.sessionId);
        }
      } catch {
        // Non-blocking: Cleanup is performed on a best-effort basis and should
        // not interfere with the primary error propagation.
      }

      throw error;
    }
  }

  /**
   * Completes OAuth authorization flow by exchanging authorization code for tokens
   * Creates new authenticated client and transport, then establishes connection
   * Saves active session to Redis after successful authentication
   * @param authCode - Authorization code received from OAuth callback
   */

  // TODO: needs to be optimized
  async finishAuth(authCode: string, state?: string): Promise<void> {
    this.emitStateChange('AUTHENTICATING');
    this.emitProgress('Exchanging authorization code for tokens...');

    await this.initialize();

    if (!this.oauthProvider) {
      const error = 'OAuth provider not initialized';
      this.emitError(error, 'auth');
      this.emitStateChange('FAILED');
      throw new Error(error);
    }

    if (state) {
      const stateCheck = await this.oauthProvider.checkState(state);
      if (!stateCheck.valid) {
        const error = stateCheck.error || 'Invalid OAuth state';
        this.emitError(error, 'auth');
        this.emitStateChange('FAILED');
        throw new Error(error);
      }

      await this.oauthProvider.consumeState(state);
    }

    /**
     * Determine which transports to try for finishing auth
     * If transportType is set, use only that. Otherwise try streamable_http then sse.
     */
    const transportsToTry: TransportType[] = this.transportType
      ? [this.transportType]
      : ['streamable-http', 'sse'];

    let lastError: unknown;
    let tokensExchanged = false;
    let authenticatedStateEmitted = false;

    for (const currentType of transportsToTry) {
      const isLastAttempt = currentType === transportsToTry[transportsToTry.length - 1];

      try {
        const transport = this.getTransport(currentType);

        /** Update local state with the transport we are about to try */
        this.transport = transport;

        if (!tokensExchanged) {
          await transport.finishAuth(authCode);
          tokensExchanged = true;
        } else {
          this.emitProgress(`Tokens already exchanged, skipping auth step for ${currentType}...`);
        }

        if (!authenticatedStateEmitted) {
          this.emitStateChange('AUTHENTICATED');
          authenticatedStateEmitted = true;
        }

        this.emitProgress('Creating authenticated client...');

        this.client = new Client(
          {
            name: MCP_CLIENT_NAME,
            version: MCP_CLIENT_VERSION,
          },
          {
            capabilities: {
              extensions: {
                'io.modelcontextprotocol/ui': {
                  mimeTypes: ['text/html+mcp'],
                },
              },
            } as McpAppClientCapabilities
          }
        );

        this.emitStateChange('CONNECTING');

        /** We explicitly try to connect with the transport we just auth'd with first */
        await this.client.connect(this.transport);

        /** Connection succeeded — lock in the transport type */
        this.transportType = currentType;

        this.emitStateChange('CONNECTED');
        // Update session with 12hr TTL after successful OAuth
        console.log(`[MCPClient] Updating session ${this.sessionId} to 12hr TTL (OAuth complete)`);
        await this.saveSession(SESSION_TTL_SECONDS, true);

        return; // Success, exit function

      } catch (error) {
        lastError = error;

        const isAuthError = error instanceof SDKUnauthorizedError ||
          (error instanceof Error && error.message.toLowerCase().includes('unauthorized'));

        if (isAuthError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        // Don't retry if the authorization code was rejected (it's one-time use)
        if (!tokensExchanged && errorMessage.toLowerCase().includes('invalid authorization code')) {
          const msg = error instanceof Error ? error.message : 'Authentication failed';
          this.emitError(msg, 'auth');
          this.emitStateChange('FAILED');
          throw error;
        }

        if (isLastAttempt) {
          const msg = error instanceof Error ? error.message : 'Authentication failed';
          this.emitError(msg, 'auth');
          this.emitStateChange('FAILED');
          throw error;
        }

        // Log and retry
        this.emitProgress(`Auth attempt with ${currentType} failed: ${errorMessage}. Retrying...`);
      }
    }

    if (lastError) {
      const errorMessage = lastError instanceof Error ? lastError.message : 'Authentication failed';
      this.emitError(errorMessage, 'auth');
      this.emitStateChange('FAILED');
      throw lastError;
    }
  }

  /**
   * Lists all available tools from the connected MCP server
   * @returns List of tools with their schemas and descriptions
   * @throws {Error} When client is not connected
   */
  async listTools(): Promise<ListToolsResult> {
    if (!this.client) {
      throw new Error('Not connected to server');
    }

    this.emitStateChange('DISCOVERING');

    try {
      const request: ListToolsRequest = {
        method: 'tools/list',
        params: {},
      };

      const result = await this.client.request(request, ListToolsResultSchema);

      if (this.serverId) {
        this._onConnectionEvent.fire({
          type: 'tools_discovered',
          sessionId: this.sessionId,
          serverId: this.serverId,
          toolCount: result.tools.length,
          tools: result.tools,
          timestamp: Date.now(),
        });
      }

      this.emitStateChange('READY');
      this.emitProgress(`Discovered ${result.tools.length} tools`);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to list tools';
      this.emitError(errorMessage, 'validation');
      this.emitStateChange('FAILED');
      throw error;
    }
  }

  /**
   * Executes a tool on the connected MCP server
   * @param toolName - Name of the tool to execute
   * @param toolArgs - Arguments to pass to the tool
   * @returns Tool execution result
   * @throws {Error} When client is not connected
   */
  async callTool(toolName: string, toolArgs: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error('Not connected to server');
    }

    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArgs,
      },
    };

    try {
      const result = await this.client.request(request, CallToolResultSchema);

      this._onObservabilityEvent.fire({
        type: 'mcp:client:tool_call',
        level: 'info',
        message: `Tool ${toolName} called successfully`,
        displayMessage: `Called tool ${toolName}`,
        sessionId: this.sessionId,
        serverId: this.serverId,
        payload: {
          toolName,
          args: toolArgs,
        },
        timestamp: Date.now(),
        id: nanoid(),
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `Failed to call tool ${toolName}`;

      this._onObservabilityEvent.fire({
        type: 'mcp:client:error',
        level: 'error',
        message: errorMessage,
        displayMessage: `Failed to call tool ${toolName}`,
        sessionId: this.sessionId,
        serverId: this.serverId,
        payload: {
          errorType: 'tool_execution',
          error: errorMessage,
          toolName,
          args: toolArgs,
        },
        timestamp: Date.now(),
        id: nanoid(),
      });

      throw error;
    }
  }

  /**
   * Lists all available prompts from the connected MCP server
   * @returns List of available prompts
   * @throws {Error} When client is not connected
   */
  async listPrompts(): Promise<ListPromptsResult> {
    if (!this.client) {
      throw new Error('Not connected to server');
    }

    this.emitStateChange('DISCOVERING');

    try {
      const request: ListPromptsRequest = {
        method: 'prompts/list',
        params: {},
      };

      const result = await this.client.request(request, ListPromptsResultSchema);

      this.emitStateChange('READY');
      this.emitProgress(`Discovered ${result.prompts.length} prompts`);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to list prompts';
      this.emitError(errorMessage, 'validation');
      this.emitStateChange('FAILED');
      throw error;
    }
  }

  /**
   * Gets a specific prompt with arguments
   * @param name - Name of the prompt
   * @param args - Arguments for the prompt
   * @returns Prompt content
   * @throws {Error} When client is not connected
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    if (!this.client) {
      throw new Error('Not connected to server');
    }

    const request: GetPromptRequest = {
      method: 'prompts/get',
      params: {
        name,
        arguments: args,
      },
    };

    return await this.client.request(request, GetPromptResultSchema);
  }

  /**
   * Lists all available resources from the connected MCP server
   * @returns List of available resources
   * @throws {Error} When client is not connected
   */
  async listResources(): Promise<ListResourcesResult> {
    if (!this.client) {
      throw new Error('Not connected to server');
    }

    this.emitStateChange('DISCOVERING');

    try {
      const request: ListResourcesRequest = {
        method: 'resources/list',
        params: {},
      };

      const result = await this.client.request(request, ListResourcesResultSchema);

      this.emitStateChange('READY');
      this.emitProgress(`Discovered ${result.resources.length} resources`);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to list resources';
      this.emitError(errorMessage, 'validation');
      this.emitStateChange('FAILED');
      throw error;
    }
  }

  /**
   * Reads a specific resource
   * @param uri - URI of the resource to read
   * @returns Resource content
   * @throws {Error} When client is not connected
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!this.client) {
      throw new Error('Not connected to server');
    }

    const request: ReadResourceRequest = {
      method: 'resources/read',
      params: {
        uri,
      },
    };

    return await this.client.request(request, ReadResourceResultSchema);
  }

  /**
   * Reconnects to MCP server using existing OAuth provider from Redis
   * Used for session restoration in serverless environments
   * Creates new client and transport without re-initializing OAuth provider
   * @throws {Error} When OAuth provider is not initialized
   */
  async reconnect(): Promise<void> {
    await this.initialize();

    if (!this.oauthProvider) {
      throw new Error('OAuth provider not initialized');
    }

    this.client = new Client(
      {
        name: MCP_CLIENT_NAME,
        version: MCP_CLIENT_VERSION,
      },
      { capabilities: {} }
    );

    // Use default logic to get transport, defaulting to what's stored or auto
    const tt = this.transportType || 'streamable-http';
    this.transport = this.getTransport(tt);

    await this.client.connect(this.transport);
  }

  /**
   * Completely removes the session from Redis including all OAuth data
   * Invalidates credentials and disconnects the client
   */
  async clearSession(): Promise<void> {
    try {
      await this.initialize();
    } catch (error) {
      console.warn('[MCPClient] Initialization failed during clearSession:', error);
    }

    if (this.oauthProvider) {
      await (this.oauthProvider as any).invalidateCredentials('all');
    }

    await sessions.delete(this.userId, this.sessionId);
    this.disconnect();
  }

  /**
   * Checks if the client is currently connected to an MCP server
   * @returns True if connected, false otherwise
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Disconnects from the MCP server and cleans up resources
   * Does not remove session from Redis - use clearSession() for that
   */
  disconnect(reason?: string): void {
    if (this.client) {
      this.client.close();
    }
    this.client = null;
    this.oauthProvider = null;
    this.transport = null;

    // Emit disconnected event
    if (this.serverId) {
      this._onConnectionEvent.fire({
        type: 'disconnected',
        sessionId: this.sessionId,
        serverId: this.serverId,
        reason,
        timestamp: Date.now(),
      });

      this._onObservabilityEvent.fire({
        type: 'mcp:client:disconnect',
        level: 'info',
        message: `Disconnected from ${this.serverId}`,
        sessionId: this.sessionId,
        serverId: this.serverId,
        payload: {
          reason: reason || 'unknown',
        },
        timestamp: Date.now(),
        id: nanoid(),
      });
    }

    this.emitStateChange('DISCONNECTED');
  }

  /**
   * Dispose of all event emitters
   * Call this when the client is no longer needed
   */
  dispose(): void {
    this._onConnectionEvent.dispose();
    this._onObservabilityEvent.dispose();
  }

  /**
   * Gets the server URL
   * @returns Server URL or empty string if not set
   */
  getServerUrl(): string {
    return this.serverUrl || '';
  }

  /**
   * Gets the OAuth callback URL
   * @returns Callback URL or empty string if not set
   */
  getCallbackUrl(): string {
    return this.callbackUrl || '';
  }

  /**
   * Gets the transport type being used
   * @returns Transport type (defaults to 'streamable-http')
   */
  getTransportType(): TransportType {
    return this.transportType || 'streamable-http';
  }

  /**
   * Gets the human-readable server name
   * @returns Server name or undefined
   */
  getServerName(): string | undefined {
    // Temporarily avoid deriving serverName from serverVersion metadata.
    // const info = (this.client as any)?.getServerVersion();
    // return info?.title ?? info?.name ?? this.serverName;
    return this.serverName;
  }

  /**
   * Gets the server ID
   * @returns Server ID or undefined
   */
  getServerId(): string | undefined {
    return this.serverId;
  }

  /**
   * Gets the session ID
   * @returns Session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Gets MCP server configuration for all active user sessions
   * Loads sessions from storage and returns server connection metadata.
   * OAuth refresh is handled by SDK transports through their authProvider.
   * @deprecated This returns legacy connection metadata only and does not
   * include OAuth tokens or generated Authorization headers. Prefer
   * MultiSessionClient or explicit MCPClient instances so SDK transports can
   * own OAuth refresh and reauthorization.
   * @param userId - User ID to fetch sessions for
   * @returns Object keyed by sanitized server labels containing transport and url.
   * @static
   */
  static async getMcpServerConfig(userId: string): Promise<Record<string, any>> {
    const mcpConfig: Record<string, any> = {};
    const sessionList = await sessions.list(userId);

    await Promise.all(
      sessionList.map(async (sessionData) => {
        const { sessionId } = sessionData;

        try {
          // Validate session - remove if missing required fields
          if (
            !sessionData.serverId ||
            !sessionData.transportType ||
            !sessionData.serverUrl ||
            !sessionData.callbackUrl
          ) {
            await sessions.delete(userId, sessionId);
            return;
          }

          // Build server config
          const label = sanitizeServerLabel(
            sessionData.serverName || sessionData.serverId || 'server'
          );

          mcpConfig[label] = {
            transport: sessionData.transportType,
            url: sessionData.serverUrl,
            ...(sessionData.serverName && {
              serverName: sessionData.serverName,
              serverLabel: label,
            }),
          };
        } catch (error) {
          await sessions.delete(userId, sessionId);
          console.warn(`[MCP] Failed to process session ${sessionId}:`, error);
        }
      })
    );

    return mcpConfig;
  }

}
