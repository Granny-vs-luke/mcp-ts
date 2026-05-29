
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
    authUrl?: string | null;
    /**
     * Session status marker used for TTL transitions:
     * - false: short-lived intermediate/error/auth-pending session state
     *          (keep this value when connection/auth is incomplete or failed)
     * - true: active long-lived session state after successful connection/auth completion
     */
    active?: boolean;
}

export interface SessionCredentials {
    sessionId: string;
    userId: string;
    clientInformation?: OAuthClientInformationMixed | null;
    tokens?: OAuthTokens | null;
    codeVerifier?: string | null;
    clientId?: string | null;
    oauthState?: OAuthState | null;
}

export type SessionWithCredentials = Session & Omit<Partial<SessionCredentials>, 'sessionId' | 'userId'>;

export type SessionMutationType = 'create' | 'update' | 'delete';

export interface SessionMutationEvent {
    type: SessionMutationType;
    userId: string;
    sessionId: string;
    timestamp: number;
    session?: SessionWithCredentials;
    patch?: Partial<SessionWithCredentials>;
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
    create(session: SessionWithCredentials, ttl?: number): Promise<void>;

    /**
     * Updates an existing session with partial data. Throws if session does not exist.
     * @param userId - User identifier
     * @param sessionId - Session identifier
     * @param data - Partial session data to update
     * @param ttl - Optional TTL in seconds (defaults to backend's default)
     */
    update(userId: string, sessionId: string, data: Partial<SessionWithCredentials>, ttl?: number): Promise<void>;

    /**
     * Updates only runtime credentials for an existing session.
     * These values are separated from connection metadata in durable SQL stores.
     */
    updateCredentials(userId: string, sessionId: string, data: Partial<SessionCredentials>, ttl?: number): Promise<void>;

    /**
     * Retrieves a session
     */
    get(userId: string, sessionId: string): Promise<SessionWithCredentials | null>;

    /**
     * Retrieves runtime credentials for a session.
     */
    getCredentials(userId: string, sessionId: string): Promise<SessionCredentials | null>;

    /**
     * Clears runtime credentials without removing connection metadata.
     */
    clearCredentials(userId: string, sessionId: string): Promise<void>;

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
