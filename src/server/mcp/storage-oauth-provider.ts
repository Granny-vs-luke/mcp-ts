import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { StorageBackend, SessionData } from "../../shared/storage.js";
import {
    DEFAULT_CLIENT_NAME,
    DEFAULT_CLIENT_URI,
    DEFAULT_LOGO_URI,
    DEFAULT_POLICY_URI,
    SOFTWARE_ID,
    SOFTWARE_VERSION,
    TOKEN_EXPIRY_BUFFER_MS,
} from '../../shared/constants.js';

/**
 * Extension of OAuthClientProvider interface with additional methods.
 * Enables server-specific tracking and state management.
 */
export interface AgentsOAuthProvider extends OAuthClientProvider {
    authUrl: string | undefined;
    clientId: string | undefined;
    serverId: string | undefined;
    checkState(
        state: string
    ): Promise<{ valid: boolean; serverId?: string; error?: string }>;
    consumeState(state: string): Promise<void>;
    deleteCodeVerifier(): Promise<void>;
    isTokenExpired(): boolean;
    setTokenExpiresAt(expiresAt: number): void;
}

export interface StorageOAuthClientProviderOptions {
    identity: string;
    serverId: string;
    sessionId: string;
    redirectUrl: string;
    clientName?: string;
    clientUri?: string;
    logoUri?: string;
    policyUri?: string;
    clientId?: string;
    clientSecret?: string;
    onRedirect?: (url: string) => void;

    /**
     * The storage backend to use for persisting OAuth state.
     *
     * ─── Server-side usage ─────────────────────────────────────────────────────
     * Leave `undefined` to use the global singleton (auto-detected from env vars).
     * This is the default behaviour when you use `sseHandler` / `nextHandlers`.
     *
     * ─── Browser-side usage ────────────────────────────────────────────────────
     * Pass a `LocalStorageBackend` (or any `StorageBackend` implementation) to
     * opt in to a fully client-side architecture without a backend proxy.
     *
     * @example
     * // Browser (pure front-end, no sseHandler)
     * import { LocalStorageBackend } from '@mcp-ts/sdk/client';
     *
     * new StorageOAuthClientProvider({
     *   ...opts,
     *   storage: new LocalStorageBackend({ namespace: 'my-app' }),
     * });
     */
    storage?: StorageBackend;
}

/**
 * Storage-backed OAuth provider for MCP.
 *
 * Reads and writes OAuth tokens, PKCE code verifiers, and client information
 * through any {@link StorageBackend}. Works transparently with both the
 * server-side global store and browser-side `LocalStorageBackend`.
 */
export class StorageOAuthClientProvider implements AgentsOAuthProvider {
    public readonly identity: string;
    public readonly serverId: string;
    public readonly sessionId: string;
    public readonly redirectUrl: string;

    private readonly clientName?: string;
    private readonly clientUri?: string;
    private readonly logoUri?: string;
    private readonly policyUri?: string;
    private readonly clientSecret?: string;

    /** Injected or lazily-resolved storage backend */
    private readonly _storage: StorageBackend | undefined;

    private _authUrl: string | undefined;
    private _clientId: string | undefined;
    private onRedirectCallback?: (url: string) => void;
    private tokenExpiresAt?: number;

    /**
     * Creates a new storage-backed OAuth provider
     * @param options - Provider configuration
     */
    constructor(options: StorageOAuthClientProviderOptions) {
        this.identity = options.identity;
        this.serverId = options.serverId;
        this.sessionId = options.sessionId;
        this.redirectUrl = options.redirectUrl;
        this.clientName = options.clientName;
        this.clientUri = options.clientUri;
        this.logoUri = options.logoUri;
        this.policyUri = options.policyUri;
        this._clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.onRedirectCallback = options.onRedirect;
        this._storage = options.storage;
    }

    // ─── Storage resolution ─────────────────────────────────────────────────

    /**
     * Resolves the active storage backend.
     *
     * When an explicit backend was passed via DI, use it directly.
     * Otherwise, fall back to the global server-side singleton (lazy import
     * keeps this tree-shakeable for browser bundles when DI is used).
     */
    private async getBackend(): Promise<StorageBackend> {
        if (this._storage) return this._storage;
        // Lazy import → the server storage module is never bundled when
        // a browser-side backend is passed via constructor injection.
        const { storage } = await import('../storage/index.js');
        return storage;
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    /**
     * Loads OAuth data from the storage session.
     * Returns an empty object if the session does not exist yet.
     */
    private async getSessionData(): Promise<SessionData> {
        const backend = await this.getBackend();
        const data = await backend.getSession(this.identity, this.sessionId);
        return data ?? ({} as SessionData);
    }

    /**
     * Persists partial OAuth data back into the current session.
     * The session must already exist (created by the controller layer) before
     * this method is called, otherwise the backend will throw.
     */
    private async saveSessionData(data: Partial<SessionData>): Promise<void> {
        const backend = await this.getBackend();
        await backend.updateSession(this.identity, this.sessionId, data);
    }

    // ─── OAuthClientProvider interface ──────────────────────────────────────

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: this.clientName || DEFAULT_CLIENT_NAME,
            client_uri: this.clientUri || DEFAULT_CLIENT_URI,
            logo_uri: this.logoUri || DEFAULT_LOGO_URI,
            policy_uri: this.policyUri || DEFAULT_POLICY_URI,
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: [this.redirectUrl],
            response_types: ["code"],
            token_endpoint_auth_method: this.clientSecret ? "client_secret_basic" : "none",
            software_id: SOFTWARE_ID,
            software_version: SOFTWARE_VERSION,
        };
    }

    get clientId() {
        return this._clientId;
    }

    set clientId(clientId_: string | undefined) {
        this._clientId = clientId_;
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        const data = await this.getSessionData();

        if (data.clientId && !this._clientId) {
            this._clientId = data.clientId;
        }

        if (data.clientInformation) {
            return data.clientInformation;
        }

        if (!this._clientId) {
            return undefined;
        }

        return {
            client_id: this._clientId,
            ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
        };
    }

    async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
        await this.saveSessionData({
            clientInformation,
            clientId: clientInformation.client_id
        });
        this.clientId = clientInformation.client_id;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        const data: Partial<SessionData> = { tokens };

        if (tokens.expires_in) {
            this.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000) - TOKEN_EXPIRY_BUFFER_MS;
        }

        await this.saveSessionData(data);
    }

    get authUrl() {
        return this._authUrl;
    }

    async state(): Promise<string> {
        return this.sessionId;
    }

    async checkState(_state: string): Promise<{ valid: boolean; serverId?: string; error?: string }> {
        const backend = await this.getBackend();
        const data = await backend.getSession(this.identity, this.sessionId);

        if (!data) {
            return { valid: false, error: "Session not found" };
        }

        return { valid: true, serverId: this.serverId };
    }

    async consumeState(_state: string): Promise<void> {
        // No-op — state is carried by the sessionId itself
    }

    async redirectToAuthorization(authUrl: URL): Promise<void> {
        this._authUrl = authUrl.toString();
        if (this.onRedirectCallback) {
            this.onRedirectCallback(authUrl.toString());
        }
    }

    async invalidateCredentials(
        scope: "all" | "client" | "tokens" | "verifier"
    ): Promise<void> {
        const backend = await this.getBackend();

        if (scope === "all") {
            await backend.removeSession(this.identity, this.sessionId);
        } else {
            const updates: Partial<SessionData> = {};

            if (scope === "client") {
                updates.clientInformation = undefined;
                updates.clientId = undefined;
            } else if (scope === "tokens") {
                updates.tokens = undefined;
            } else if (scope === "verifier") {
                updates.codeVerifier = undefined;
            }
            await this.saveSessionData(updates);
        }
    }

    async saveCodeVerifier(verifier: string): Promise<void> {
        await this.saveSessionData({ codeVerifier: verifier });
    }

    async codeVerifier(): Promise<string> {
        const data = await this.getSessionData();

        if (data.clientId && !this._clientId) {
            this._clientId = data.clientId;
        }

        if (!data.codeVerifier) {
            throw new Error("No code verifier found");
        }
        return data.codeVerifier;
    }

    async deleteCodeVerifier(): Promise<void> {
        await this.saveSessionData({ codeVerifier: undefined });
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const data = await this.getSessionData();

        if (data.clientId && !this._clientId) {
            this._clientId = data.clientId;
        }

        return data.tokens;
    }

    isTokenExpired(): boolean {
        if (!this.tokenExpiresAt) {
            return false;
        }
        return Date.now() >= this.tokenExpiresAt;
    }

    setTokenExpiresAt(expiresAt: number): void {
        this.tokenExpiresAt = expiresAt;
    }
}
