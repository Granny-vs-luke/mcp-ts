

import { MCPClient } from './oauth-client.js';
import { sessions, type Session } from '../storage/index.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const CONNECTION_BATCH_SIZE = 5;

/**
 * Manages multiple MCP connections for a single user.
 * Allows aggregating tools from all connected servers.
 */
export interface MultiSessionOptions {
    /**
     * Connection timeout in milliseconds
     * @default 15000
     */
    timeout?: number;
    /**
     * Maximum number of retry attempts
     * @default 2
     */
    maxRetries?: number;
    /**
     * Delay between retries in milliseconds
     * @default 1000
     */
    retryDelay?: number;
}

/**
 * Manages multiple MCP client connections for a single user.
 *
 * On a traditional long-running server, you can cache this instance per user
 * so the connections stay alive between requests. On serverless, a new instance
 * will be created per invocation, but the underlying session data is always
 * read from the storage backend so nothing is lost between calls.
 */
export class MultiSessionClient {
    private clients: MCPClient[] = [];
    private userId: string;
    private options: MultiSessionOptions;

    /**
     * Creates a new MultiSessionClient for the given user userId.
     *
     * @param userId - A unique string identifying the user (e.g. user ID or email).
     * @param options  - Optional tuning for connection timeout, retry count, and retry delay.
     *                   Falls back to sensible defaults if not provided.
     */
    constructor(userId: string, options: MultiSessionOptions = {}) {
        this.userId = userId;
        this.options = {
            timeout: DEFAULT_TIMEOUT_MS,
            maxRetries: DEFAULT_MAX_RETRIES,
            retryDelay: DEFAULT_RETRY_DELAY_MS,
            ...options
        };
    }

    /**
     * Fetches all sessions for this userId from storage and returns only the
     * ones that are ready to connect.
     *
     * A session is considered connectable when:
     * - It has a `serverId`, `serverUrl`, and `callbackUrl` (i.e. it was fully initialized)
     * - Its status is `active`. Pending sessions are skipped here
     *   and let the OAuth flow complete separately before we try to reconnect them.
     */
    private async getActiveSessions(): Promise<Session[]> {
        const sessionList = await sessions.list(this.userId);
        const valid = sessionList.filter(s =>
            s.serverId &&
            s.serverUrl &&
            s.callbackUrl &&
            s.status === 'active'
        );
        return valid;
    }

    /**
     * Connects to a list of sessions in controlled batches of `CONNECTION_BATCH_SIZE`.
     *
     * Batching prevents overwhelming the event loop or external servers when a user
     * has many active MCP sessions (e.g. 20+ servers). Within each batch, sessions
     * are connected concurrently using `Promise.all` for speed.
     */
    private async connectInBatches(sessions: Session[]): Promise<void> {
        for (let i = 0; i < sessions.length; i += CONNECTION_BATCH_SIZE) {
            const batch = sessions.slice(i, i + CONNECTION_BATCH_SIZE);
            await Promise.all(batch.map(session => this.connectSession(session)));
        }
    }

    private connectionPromises = new Map<string, Promise<void>>();

    /**
     * Connects a single session, with built-in deduplication to prevent race conditions.
     *
     * - If a client for this session already exists and is connected, returns immediately.
     * - If a connection attempt for this session is already in-flight (e.g. from a
     *   concurrent call), it joins the existing promise instead of starting a new one.
     *   This is the key concurrency lock — the `connectionPromises` map acts as a
     *   per-session mutex so we never spin up two physical connections for the same session.
     * - On completion (success or failure), the promise is cleaned up from the map.
     */
    private async connectSession(session: Session): Promise<void> {
        const existingClient = this.clients.find(c => c.getSessionId() === session.sessionId);
        if (existingClient?.isConnected()) {
            return;
        }

        // Avoid concurrent connection attempts for the same session
        if (this.connectionPromises.has(session.sessionId)) {
            return this.connectionPromises.get(session.sessionId)!;
        }

        const connectPromise = this.establishConnectionWithRetries(session);

        this.connectionPromises.set(session.sessionId, connectPromise);

        try {
            await connectPromise;
        } finally {
            this.connectionPromises.delete(session.sessionId);
        }
    }

    /**
     * The core connection loop for a single session.
     *
     * Attempts to establish a physical MCP connection, retrying up to `maxRetries` times
     * if the connection fails. Each attempt:
     * 1. Creates a fresh `MCPClient` instance from the session data.
     * 2. Races the connect call against a timeout promise — if the server doesn't respond
     *    within `timeoutMs`, the attempt is aborted and counted as a failure.
     * 3. On success, replaces any stale client entry for this session in the `clients` array.
     * 4. On failure, waits `retryDelay` ms before the next attempt.
     *
     * If all attempts are exhausted, logs an error and returns silently (does not throw),
     * so a single bad server doesn't block the rest of the batch from connecting.
     */
    private async establishConnectionWithRetries(session: Session): Promise<void> {
        const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
        const retryDelay = this.options.retryDelay ?? DEFAULT_RETRY_DELAY_MS;
        let lastError: unknown;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const client = new MCPClient({
                    userId: this.userId,
                    sessionId: session.sessionId,
                    serverId: session.serverId,
                    serverUrl: session.serverUrl,
                    callbackUrl: session.callbackUrl,
                    serverName: session.serverName,
                    transportType: session.transportType,
                    headers: session.headers,
                });

                const timeoutMs = this.options.timeout ?? DEFAULT_TIMEOUT_MS;
                let timeoutTimer: ReturnType<typeof setTimeout>;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutTimer = setTimeout(() => reject(new Error(`Connection timed out after ${timeoutMs}ms`)), timeoutMs);
                });

                try {
                    await Promise.race([client.connect(), timeoutPromise]);
                } finally {
                    clearTimeout(timeoutTimer!);
                }

                // Always replace the disconnected client entry
                this.clients = this.clients.filter(c => c.getSessionId() !== session.sessionId);
                this.clients.push(client);
                return; // successfully connected
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }

        console.error(`[MultiSessionClient] Failed to connect to session ${session.sessionId} after ${maxRetries + 1} attempts:`, lastError);
    }

    /**
     * The main entry point. Fetches all active sessions for this userId from
     * storage and establishes connections to all of them in batches.
     *
     * Call this once after creating the client. On traditional servers, you can
     * cache the `MultiSessionClient` instance after calling `connect()` to avoid
     * re-fetching and re-connecting on every request.
     */
    async connect(): Promise<void> {
        const sessions = await this.getActiveSessions();
        await this.connectInBatches(sessions);
    }

    /**
     * Returns all currently connected `MCPClient` instances.
     *
     * Use this to enumerate available tools across all connected servers,
     * or to route a tool call to the right client by `serverId`.
     */
    getClients(): MCPClient[] {
        return this.clients;
    }

    /**
     * Gracefully disconnects all active MCP clients and clears the internal client list.
     *
     * Call this during server shutdown or when a user logs out to free up
     * underlying transport resources (SSE streams, HTTP connections, etc.).
     */
    disconnect(): void {
        this.clients.forEach((client) => client.disconnect());
        this.clients = [];
    }
}

