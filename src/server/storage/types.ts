
import type { MCPClient } from '../mcp/oauth-client.js';
import type {
    OAuthTokens,
    OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface OAuthState {
    nonce: string;
    sessionId: string;
    serverId: string;
    createdAt: number;
}

export interface Session {
    sessionId: string;
    serverId?: string; // Database server ID for mapping
    serverName?: string;
    serverUrl: string;
    transportType: 'sse' | 'streamable-http';
    callbackUrl: string;
    createdAt: number;
    userId: string;
    headers?: Record<string, string>;
    /**
     * Session status marker used for TTL transitions:
     * - false: short-lived intermediate/error/auth-pending session state
     *          (keep this value when connection/auth is incomplete or failed)
     * - true: active long-lived session state after successful connection/auth completion
     */
    active?: boolean;
    // OAuth data (consolidated)
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string | null;
    clientId?: string;
    oauthState?: OAuthState | null;
}

export type SessionMutationType = 'create' | 'update' | 'delete';

export interface SessionMutationEvent {
    type: SessionMutationType;
    userId: string;
    sessionId: string;
    timestamp: number;
    session?: Session;
    patch?: Partial<Session>;
    ttl?: number;
}

export type SessionMutationListener = (event: SessionMutationEvent) => void | Promise<void>;

export interface SetClientOptions {
    sessionId: string;
    serverId?: string; // Database server ID
    serverName?: string; // Human-readable server name
    client?: MCPClient;
    serverUrl?: string;
    callbackUrl?: string;
    transportType?: 'sse' | 'streamable-http';
    userId?: string;
    headers?: Record<string, string>;
}

/**
 * Interface for MCP session stores.
 */
export interface SessionStore {
    /**
     * Optional initialization (e.g., database connection)
     */
    init?(): Promise<void>;

    /**
     * Generates a unique session ID
     */
    generateSessionId(): string;

    /**
     * Creates a new session. Throws if session already exists.
     * @param session - Session data to create
     * @param ttl - Optional TTL in seconds (defaults to backend's default)
     */
    create(session: Session, ttl?: number): Promise<void>;

    /**
     * Updates an existing session with partial data. Throws if session does not exist.
     * @param userId - User identifier
     * @param sessionId - Session identifier
     * @param data - Partial session data to update
     * @param ttl - Optional TTL in seconds (defaults to backend's default)
     */
    update(userId: string, sessionId: string, data: Partial<Session>, ttl?: number): Promise<void>;

    /**
     * Retrieves a session
     */
    get(userId: string, sessionId: string): Promise<Session | null>;

    /**
     * Gets full session data for all sessions owned by a user
     */
    list(userId: string): Promise<Session[]>;

    /**
     * Removes a session
     */
    delete(userId: string, sessionId: string): Promise<void>;

    /**
     * Gets all session IDs owned by a user
     */
    listIds(userId: string): Promise<string[]>;

    /**
     * Gets all session IDs across all users (Admin)
     */
    listAllIds(): Promise<string[]>;

    /**
     * Clears all sessions (Admin)
     */
    clearAll(): Promise<void>;

    /**
     * Clean up expired sessions
     */
    cleanupExpired(): Promise<void>;

    /**
     * Disconnect from storage backend
     */
    disconnect(): Promise<void>;
}
