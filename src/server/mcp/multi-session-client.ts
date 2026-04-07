import { MCPClient } from './oauth-client.js';
import type { StorageBackend, SessionData } from '../../shared/storage.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const CONNECTION_BATCH_SIZE = 5;

/**
 * Options for tuning the connection behaviour of {@link MultiSessionClient}.
 */
export interface MultiSessionOptions {
    /**
     * Connection timeout in milliseconds.
     * @default 15000
     */
    timeout?: number;

    /**
     * Maximum number of retry attempts per session.
     * @default 2
     */
    maxRetries?: number;

    /**
     * Delay between retry attempts in milliseconds.
     * @default 1000
     */
    retryDelay?: number;

    /**
     * Storage backend to use for session persistence.
     *
     * ─── Server-side (default) ───────────────────────────────────────────────
     * Omit this field to use the global auto-detected backend (Redis, Supabase,
     * SQLite, File or Memory, resolved from environment variables). This works
     * seamlessly with `sseHandler` / `nextHandlers`.
     *
     * ─── Browser-side (pure front-end, no sseHandler) ───────────────────────
     * Pass a `LocalStorageBackend` to run the entire MCP stack inside the
     * browser without a Node.js proxy. The browser will connect directly to
     * remote MCP servers — make sure CORS is enabled on those servers.
     *
     * @example
     * // Browser-only usage
     * import { LocalStorageBackend } from '@mcp-ts/sdk/client';
     *
     * const client = new MultiSessionClient('user-123', {
     *   storage: new LocalStorageBackend({ namespace: 'my-app' }),
     * });
     */
    storage?: StorageBackend;
}

/**
 * Manages multiple MCP client connections for a single user identity.
 *
 * ─── Server-side usage (default) ────────────────────────────────────────────
 * On a traditional long-running server, cache this instance per user so the
 * connections stay alive between requests. On serverless, a new instance will
 * be created per invocation, but the underlying session data is always read
 * from the storage backend so nothing is lost between calls.
 *
 * ─── Browser-side usage ─────────────────────────────────────────────────────
 * Pass a `LocalStorageBackend` via options.storage to run the full MCP stack
 * in the browser without any proxy server.
 *
 * @example
 * // Server-side (auto backend selection via env vars)
 * const client = new MultiSessionClient('user-123');
 * await client.connect();
 *
 * // Browser-side (localStorage)
 * import { LocalStorageBackend } from '@mcp-ts/sdk/client';
 * const client = new MultiSessionClient('user-123', {
 *   storage: new LocalStorageBackend({ namespace: 'my-app' }),
 * });
 * await client.connect();
 */
export class MultiSessionClient {
    private clients: MCPClient[] = [];
    private readonly identity: string;
    private readonly options: MultiSessionOptions;

    constructor(identity: string, options: MultiSessionOptions = {}) {
        this.identity = identity;
        this.options = {
            timeout: DEFAULT_TIMEOUT_MS,
            maxRetries: DEFAULT_MAX_RETRIES,
            retryDelay: DEFAULT_RETRY_DELAY_MS,
            ...options,
        };
    }

    // ─── Storage resolution ──────────────────────────────────────────────────

    /**
     * Resolves the active storage backend.
     *
     * Uses an explicitly injected backend when provided. Falls back to the
     * global server-side singleton via a lazy import so that browser bundles
     * are not polluted with Node.js-only modules when DI is used.
     */
    private async getBackend(): Promise<StorageBackend> {
        if (this.options.storage) return this.options.storage;
        const { storage } = await import('../storage/index.js');
        return storage;
    }

    // ─── Session discovery ───────────────────────────────────────────────────

    /**
     * Fetches all sessions for this identity from storage and returns only the
     * ones that are ready to connect.
     *
     * A session is considered connectable when:
     * - It has a `serverId`, `serverUrl`, and `callbackUrl` (i.e. it was fully
     *   initialized and not just an in-progress OAuth stub).
     * - Its `active` flag is not explicitly `false` — sessions with
     *   `active: false` are either mid-OAuth flow, auth-pending, or previously
     *   failed. We skip those here and let the OAuth flow complete separately.
     *
     * Note: Sessions where `active` is `undefined` (legacy records) are included
     * for backwards compatibility.
     */
    private async getActiveSessions(): Promise<SessionData[]> {
        const backend = await this.getBackend();
        const sessions = await backend.getIdentitySessionsData(this.identity);
        return sessions.filter(
            (s) => s.serverId && s.serverUrl && s.callbackUrl && s.active !== false
        );
    }

    // ─── Batch connection ────────────────────────────────────────────────────

    /**
     * Connects to a list of sessions in controlled batches of
     * {@link CONNECTION_BATCH_SIZE}.
     *
     * Batching prevents overwhelming the event loop or external servers when a
     * user has many active MCP sessions. Within each batch, sessions are
     * connected concurrently using `Promise.all` for maximum throughput.
     */
    private async connectInBatches(sessions: SessionData[]): Promise<void> {
        for (let i = 0; i < sessions.length; i += CONNECTION_BATCH_SIZE) {
            const batch = sessions.slice(i, i + CONNECTION_BATCH_SIZE);
            await Promise.all(batch.map((session) => this.connectSession(session)));
        }
    }

    private connectionPromises = new Map<string, Promise<void>>();

    /**
     * Connects a single session with built-in deduplication to prevent race
     * conditions.
     *
     * - If a client for this session already exists and is connected, returns
     *   immediately.
     * - If a connection attempt for this session is already in-flight (e.g.
     *   from a concurrent call), it joins the existing promise instead of
     *   starting a new one. This acts as a per-session mutex so we never spin
     *   up two physical connections for the same session.
     * - On completion (success or failure), the promise is cleaned up from the
     *   map.
     */
    private async connectSession(session: SessionData): Promise<void> {
        const existingClient = this.clients.find(
            (c) => c.getSessionId() === session.sessionId
        );
        if (existingClient?.isConnected()) {
            return;
        }

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
     * Attempts to establish a physical MCP connection, retrying up to
     * `maxRetries` times if the connection fails. Each attempt:
     * 1. Creates a fresh `MCPClient` instance from the session data, passing
     *    the injected storage backend through.
     * 2. Races the connect call against a timeout — if the server doesn't
     *    respond within `timeoutMs`, the attempt is aborted.
     * 3. On success, replaces any stale client entry for this session in the
     *    internal `clients` array.
     * 4. On failure, waits `retryDelay` ms before the next attempt.
     *
     * If all attempts are exhausted, logs an error and returns silently (does
     * not throw) so a single bad server doesn't block the rest of the batch.
     */
    private async establishConnectionWithRetries(session: SessionData): Promise<void> {
        const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
        const retryDelay = this.options.retryDelay ?? DEFAULT_RETRY_DELAY_MS;
        let lastError: unknown;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const client = new MCPClient({
                    identity: this.identity,
                    sessionId: session.sessionId,
                    serverId: session.serverId,
                    serverUrl: session.serverUrl,
                    callbackUrl: session.callbackUrl,
                    serverName: session.serverName,
                    transportType: session.transportType,
                    headers: session.headers,
                    // Pass the injected storage through so each individual
                    // client uses the same backend for session state.
                    storage: this.options.storage,
                });

                const timeoutMs = this.options.timeout ?? DEFAULT_TIMEOUT_MS;
                let timeoutTimer: ReturnType<typeof setTimeout>;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutTimer = setTimeout(
                        () => reject(new Error(`Connection timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                });

                try {
                    await Promise.race([client.connect(), timeoutPromise]);
                } finally {
                    clearTimeout(timeoutTimer!);
                }

                // Replace any stale client entry for this session
                this.clients = this.clients.filter(
                    (c) => c.getSessionId() !== session.sessionId
                );
                this.clients.push(client);
                return; // successfully connected
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, retryDelay));
                }
            }
        }

        console.error(
            `[MultiSessionClient] Failed to connect to session ${session.sessionId} after ${maxRetries + 1} attempts:`,
            lastError
        );
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Fetches all active sessions for this identity from storage and
     * establishes connections to all of them in batches.
     *
     * Call this once after creating the client. On traditional servers, cache
     * the `MultiSessionClient` instance after calling `connect()` to avoid
     * re-fetching and re-connecting on every request.
     */
    async connect(): Promise<void> {
        const sessions = await this.getActiveSessions();
        await this.connectInBatches(sessions);
    }

    /**
     * Returns all currently connected {@link MCPClient} instances.
     *
     * Use this to enumerate available tools across all connected servers, or
     * to route a tool call to the right client by `serverId`.
     */
    getClients(): MCPClient[] {
        return this.clients;
    }

    /**
     * Gracefully disconnects all active MCP clients and clears the internal
     * client list.
     *
     * Call this during server shutdown or when a user logs out to free up
     * underlying transport resources (SSE streams, HTTP connections, etc.).
     */
    disconnect(): void {
        this.clients.forEach((client) => client.disconnect());
        this.clients = [];
    }
}
