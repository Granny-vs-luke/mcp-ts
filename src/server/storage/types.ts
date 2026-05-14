
import type { MCPClient } from '../mcp/oauth-client.js';
import type {
    OAuthTokens,
    OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface SessionData {
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
    codeVerifier?: string;
    clientId?: string;
}

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
 * Interface for MCP Session Storage Backends
 */
export interface StorageBackend {
    /**
     * Optional initialization (e.g., database connection)
     */
    init?(): Promise<void>;

    /**
     * Generates a unique session ID
     */
    generateSessionId(): string;

    /**
     * Stores or updates a session
     */
    /**
     * Creates a new session. Throws if session already exists.
     * @param session - Session data to create
     * @param ttl - Optional TTL in seconds (defaults to backend's default)
     */
    createSession(session: SessionData, ttl?: number): Promise<void>;

    /**
     * Updates an existing session with partial data. Throws if session does not exist.
     * @param userId - User userId
     * @param sessionId - Session identifier
     * @param data - Partial session data to update
     * @param ttl - Optional TTL in seconds (defaults to backend's default)
     */
    updateSession(userId: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void>;

    /**
     * Retrieves a session
     */
    getSession(userId: string, sessionId: string): Promise<SessionData | null>;

    /**
     * Gets full session data for all of an userId's sessions
     */
    getUserSession(userId: string): Promise<SessionData[]>;

    /**
     * Removes a session
     */
    removeSession(userId: string, sessionId: string): Promise<void>;

    /**
     * Gets all sessions IDs of an userId
     */
    getUserSessionIds(userId: string): Promise<string[]>;

    /**
     * Gets all session IDs across all users (Admin)
     */
    getAllSessionIds(): Promise<string[]>;

    /**
     * Clears all sessions (Admin)
     */
    clearAll(): Promise<void>;

    /**
     * Clean up expired sessions
     */
    cleanupExpiredSessions(): Promise<void>;

    /**
     * Disconnect from storage backend
     */
    disconnect(): Promise<void>;
}
