import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { nanoid } from "nanoid";
import { sessions, type SessionCredentials } from "../storage/index.js";
import {
    DEFAULT_CLIENT_NAME,
    DEFAULT_CLIENT_URI,
    DEFAULT_LOGO_URI,
    DEFAULT_POLICY_URI,
    SOFTWARE_ID,
    SOFTWARE_VERSION,
    STATE_EXPIRATION_MS,
} from '../../shared/constants.js';
import { formatOAuthState, parseOAuthState } from '../../shared/utils.js';

/**
 * Extension of OAuthClientProvider interface with additional methods
 * Enables server-specific tracking and state management
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
}

export interface StorageOAuthClientProviderOptions {
    userId: string;
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
}

/**
 * Storage-backed OAuth provider implementation for MCP
 * Stores OAuth tokens, client information, and PKCE verifiers using the configured SessionStore
 */
export class StorageOAuthClientProvider implements AgentsOAuthProvider {
    public readonly userId: string;
    public readonly serverId: string;
    public readonly sessionId: string;
    public readonly redirectUrl: string;

    private readonly clientName?: string;
    private readonly clientUri?: string;
    private readonly logoUri?: string;
    private readonly policyUri?: string;
    private readonly clientSecret?: string;

    private _authUrl: string | undefined;
    private _clientId: string | undefined;
    private _hasCodeVerifier = false;
    private onRedirectCallback?: (url: string) => void;

    /**
     * Creates a new session-backed OAuth provider
     * @param options - Provider configuration
     */
    constructor(options: StorageOAuthClientProviderOptions) {
        this.userId = options.userId;
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
    }

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

    /**
     * Loads OAuth credentials from the session store
     * @private
     */
    private async getCredentials(): Promise<SessionCredentials> {
        const data = await sessions.getCredentials(this.userId, this.sessionId);
        if (!data) {
            return { userId: this.userId, sessionId: this.sessionId };
        }
        return data;
    }

    /**
     * Saves OAuth credentials to the session store
     * @param data - Partial OAuth credentials to save
     * @private
     * @throws Error if session doesn't exist (session must be created by controller layer)
     */
    private async patchCredentials(data: Partial<SessionCredentials>): Promise<void> {
        await sessions.patchCredentials(this.userId, this.sessionId, data);
    }

    /**
     * Retrieves stored OAuth client information.
     */
    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        if (this._clientId) {
            return {
                client_id: this._clientId,
                ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
            };
        }

        const data = await this.getCredentials();

        if (data.clientId) {
            this._clientId = data.clientId;
            if (data.clientInformation) {
                return data.clientInformation;
            }
            return {
                client_id: data.clientId,
                ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
            };
        }

        return undefined;
    }

    /**
     * Stores OAuth client information
     */
    async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
        await this.patchCredentials({
            clientInformation,
            clientId: clientInformation.client_id
        });
        this.clientId = clientInformation.client_id;
    }

    /**
     * Stores OAuth tokens
     */
    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await this.patchCredentials({ tokens });
    }

    /**
     * Persists static client credentials to DB immediately on creation.
     * Ensures getOrCreateClient() finds them on rehydration, even when the
     * server allows anonymous connect and never triggers DCR.
     */
    async initializeCredentials(): Promise<void> {
        if (this._clientId) {
            await this.patchCredentials({
                clientId: this._clientId,
                clientInformation: {
                    client_id: this._clientId,
                    ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
                },
            });
        }
    }

    get authUrl() {
        return this._authUrl;
    }

    async state(): Promise<string> {
        this._hasCodeVerifier = false;
        const nonce = nanoid(32);
        await this.patchCredentials({
            oauthState: {
                nonce,
                sessionId: this.sessionId,
                serverId: this.serverId,
                createdAt: Date.now(),
            },
            codeVerifier: null,
        });
        return formatOAuthState(nonce, this.sessionId);
    }

    async checkState(state: string): Promise<{ valid: boolean; serverId?: string; error?: string }> {
        const parsed = parseOAuthState(state);
        if (!parsed) {
            return { valid: false, error: "Invalid OAuth state" };
        }

        if (parsed.sessionId !== this.sessionId) {
            return { valid: false, error: "OAuth state mismatch" };
        }

        const data = await sessions.getCredentials(this.userId, parsed.sessionId);

        if (!data) {
            return { valid: false, error: "Session not found" };
        }

        const oauthState = data.oauthState;
        if (!oauthState) {
            return { valid: false, error: "OAuth state not found" };
        }

        if (
            oauthState.nonce !== parsed.nonce ||
            oauthState.sessionId !== parsed.sessionId ||
            oauthState.serverId !== this.serverId
        ) {
            return { valid: false, error: "OAuth state mismatch" };
        }

        if (Date.now() - oauthState.createdAt > STATE_EXPIRATION_MS) {
            return { valid: false, error: "OAuth state expired" };
        }

        return { valid: true, serverId: oauthState.serverId };
    }

    async consumeState(state: string): Promise<void> {
        const result = await this.checkState(state);
        if (!result.valid) {
            throw new Error(result.error || "Invalid OAuth state");
        }

        await this.patchCredentials({ oauthState: null });
    }

    async redirectToAuthorization(authUrl: URL): Promise<void> {
        this._authUrl = authUrl.toString();
        await sessions.update(this.userId, this.sessionId, { authUrl: this._authUrl });
        if (this.onRedirectCallback) {
            this.onRedirectCallback(authUrl.toString());
        }
    }

    async invalidateCredentials(
        scope: "all" | "client" | "tokens" | "verifier"
    ): Promise<void> {
        if (scope === "all") {
            await sessions.delete(this.userId, this.sessionId);
        } else {
            const updates: Partial<SessionCredentials> = {};

            if (scope === "client") {
                updates.clientInformation = null;
                updates.clientId = null;
            } else if (scope === "tokens") {
                updates.tokens = null;
            } else if (scope === "verifier") {
                updates.codeVerifier = null;
            }
            await this.patchCredentials(updates);
        }
    }

    async saveCodeVerifier(verifier: string): Promise<void> {
        if (this._hasCodeVerifier) {
            return;
        }

        await this.patchCredentials({ codeVerifier: verifier });
        this._hasCodeVerifier = true;
    }

    async codeVerifier(): Promise<string> {
        const data = await this.getCredentials();

        if (data.clientId && !this._clientId) {
            this._clientId = data.clientId;
        }

        if (!data.codeVerifier) {
            throw new Error("No code verifier found");
        }
        return data.codeVerifier;
    }

    async deleteCodeVerifier(): Promise<void> {
        await this.patchCredentials({ codeVerifier: null });
        this._hasCodeVerifier = false;
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const data = await this.getCredentials();

        if (data.clientId && !this._clientId) {
            this._clientId = data.clientId;
        }

        return data.tokens ?? undefined;
    }
}
