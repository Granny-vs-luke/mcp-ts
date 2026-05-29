import type { SessionStore, Session, SessionCredentials } from './types.js';
import { SESSION_TTL_SECONDS } from '../../shared/constants.js';
import { generateSessionId } from '../../shared/utils.js';
import { encryptObject, decryptObject } from './crypto.js';

export interface NeonStorageOptions {
    schema?: string;
    table?: string;
    credentialsTable?: string;
}

type NeonSql = {
    query(queryWithPlaceholders: string, params?: unknown[]): Promise<any[]>;
};

type NeonSessionRow = {
    id?: string;
    session_id: string;
    server_id?: string | null;
    server_name?: string | null;
    server_url: string;
    transport_type: 'sse' | 'streamable-http';
    callback_url: string;
    created_at: string | Date;
    user_id: string;
    headers?: unknown;
    auth_url?: string | null;
    active?: boolean | null;
};

type NeonCredentialsRow = {
    session_id: string;
    user_id: string;
    client_information?: unknown;
    tokens?: unknown;
    code_verifier?: unknown;
    client_id?: string | null;
    oauth_state?: unknown;
};

export class NeonStorageBackend implements SessionStore {
    private readonly DEFAULT_TTL = SESSION_TTL_SECONDS;
    private readonly tableName: string;
    private readonly credentialsTableName: string;

    constructor(
        private readonly sql: NeonSql,
        options: NeonStorageOptions = {}
    ) {
        const schema = options.schema || 'public';
        const table = options.table || 'mcp_sessions';
        const credentialsTable = options.credentialsTable || 'mcp_credentials';
        this.tableName = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`;
        this.credentialsTableName = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(credentialsTable)}`;
    }

    async init(): Promise<void> {
        await this.assertTable(this.tableName, 'mcp_sessions');
        await this.assertTable(this.credentialsTableName, 'mcp_credentials');
        console.log('[mcp-ts][Storage] Neon: storage tables verified.');
    }

    private async assertTable(qualifiedName: string, displayName: string): Promise<void> {
        const [{ exists } = { exists: null }] = await this.sql.query(
            'SELECT to_regclass($1) AS exists',
            [qualifiedName.replace(/"/g, '')]
        ) as Array<{ exists: string | null }>;

        if (!exists) {
            throw new Error(
                `[NeonStorage] Table "${displayName}" not found in your database. ` +
                'Please create it using the Neon storage guide in docs/storage-backends/neon.md.'
            );
        }
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    private quoteIdentifier(identifier: string): string {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
            throw new Error(`Invalid Neon storage identifier: ${identifier}`);
        }
        return `"${identifier}"`;
    }

    private mapRowToSessionData(row: NeonSessionRow): Session {
        return {
            sessionId: row.session_id,
            serverId: row.server_id ?? undefined,
            serverName: row.server_name ?? undefined,
            serverUrl: row.server_url,
            transportType: row.transport_type,
            callbackUrl: row.callback_url,
            createdAt: new Date(row.created_at).getTime(),
            userId: row.user_id,
            headers: decryptObject(row.headers),
            authUrl: row.auth_url ?? undefined,
            active: row.active ?? false,
        };
    }

    private mapRowToCredentials(row: NeonCredentialsRow, userId: string, sessionId: string): SessionCredentials {
        return {
            sessionId,
            userId,
            clientInformation: decryptObject(row.client_information),
            tokens: decryptObject(row.tokens),
            codeVerifier: decryptObject(row.code_verifier),
            clientId: row.client_id ?? undefined,
            oauthState: row.oauth_state as SessionCredentials['oauthState'],
        };
    }

    private hasCredentialData(data: Partial<SessionCredentials>): boolean {
        return (
            'clientInformation' in data ||
            'tokens' in data ||
            'codeVerifier' in data ||
            'clientId' in data ||
            'oauthState' in data
        );
    }

    async create(session: Session, ttl?: number): Promise<void> {
        const { sessionId, userId } = session;
        if (!sessionId || !userId) throw new Error('userId and sessionId required');

        const effectiveTtl = ttl ?? this.DEFAULT_TTL;
        const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString();

        try {
            await this.sql.query(
                `INSERT INTO ${this.tableName} (
                    session_id,
                    user_id,
                    server_id,
                    server_name,
                    server_url,
                    transport_type,
                    callback_url,
                    created_at,
                    headers,
                    auth_url,
                    active,
                    expires_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12
                )`,
                [
                    sessionId,
                    userId,
                    session.serverId,
                    session.serverName,
                    session.serverUrl,
                    session.transportType,
                    session.callbackUrl,
                    new Date(session.createdAt || Date.now()).toISOString(),
                    encryptObject(session.headers),
                    session.authUrl ?? null,
                    session.active ?? false,
                    expiresAt,
                ]
            );
        } catch (error: any) {
            if (error.code === '23505') {
                throw new Error(`Session ${sessionId} already exists`);
            }
            throw new Error(`Failed to create session in Neon: ${error.message}`);
        }

    }

    async update(userId: string, sessionId: string, data: Partial<Session>, ttl?: number): Promise<void> {
        const currentSession = await this.get(userId, sessionId);
        if (!currentSession) {
            throw new Error(`Session ${sessionId} not found for userId ${userId}`);
        }

        const updatedSession = { ...currentSession, ...data };
        const effectiveTtl = ttl ?? this.DEFAULT_TTL;
        const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString();

        const shouldUpdateSession = (
            'serverId' in data ||
            'serverName' in data ||
            'serverUrl' in data ||
            'transportType' in data ||
            'callbackUrl' in data ||
            'active' in data ||
            'headers' in data ||
            'authUrl' in data ||
            ttl !== undefined
        );

        if (shouldUpdateSession) {
            const updatedRows = await this.sql.query(
                `UPDATE ${this.tableName}
                 SET
                    server_id = $1,
                    server_name = $2,
                    server_url = $3,
                    transport_type = $4,
                    callback_url = $5,
                    active = $6,
                    headers = $7,
                    auth_url = $8,
                    expires_at = $9,
                    updated_at = now()
                 WHERE user_id = $10 AND session_id = $11
                 RETURNING id`,
                [
                    updatedSession.serverId,
                    updatedSession.serverName,
                    updatedSession.serverUrl,
                    updatedSession.transportType,
                    updatedSession.callbackUrl,
                    updatedSession.active ?? false,
                    encryptObject(updatedSession.headers),
                    updatedSession.authUrl ?? null,
                    expiresAt,
                    userId,
                    sessionId,
                ]
            ) as Array<{ id: string }>;

            if (updatedRows.length === 0) {
                throw new Error(`Session ${sessionId} not found for userId ${userId}`);
            }
        }

    }

    async patchCredentials(userId: string, sessionId: string, data: Partial<SessionCredentials>, ttl?: number): Promise<void> {
        if (!this.hasCredentialData(data)) return;

        await this.sql.query(
            `INSERT INTO ${this.credentialsTableName} (
                user_id,
                session_id,
                client_information,
                tokens,
                code_verifier,
                client_id,
                oauth_state,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
            ON CONFLICT (user_id, session_id)
            DO UPDATE SET
                client_information = CASE WHEN $8 THEN EXCLUDED.client_information ELSE ${this.credentialsTableName}.client_information END,
                tokens = CASE WHEN $9 THEN EXCLUDED.tokens ELSE ${this.credentialsTableName}.tokens END,
                code_verifier = CASE WHEN $10 THEN EXCLUDED.code_verifier ELSE ${this.credentialsTableName}.code_verifier END,
                client_id = CASE WHEN $11 THEN EXCLUDED.client_id ELSE ${this.credentialsTableName}.client_id END,
                oauth_state = CASE WHEN $12 THEN EXCLUDED.oauth_state ELSE ${this.credentialsTableName}.oauth_state END,
                updated_at = now()`,
            [
                userId,
                sessionId,
                'clientInformation' in data ? (data.clientInformation == null ? null : encryptObject(data.clientInformation)) : null,
                'tokens' in data ? (data.tokens == null ? null : encryptObject(data.tokens)) : null,
                'codeVerifier' in data ? (data.codeVerifier == null ? null : encryptObject(data.codeVerifier)) : null,
                'clientId' in data ? (data.clientId ?? null) : null,
                'oauthState' in data ? (data.oauthState ?? null) : null,
                'clientInformation' in data,
                'tokens' in data,
                'codeVerifier' in data,
                'clientId' in data,
                'oauthState' in data,
            ]
        );

        if (ttl !== undefined) {
            await this.sql.query(
                `UPDATE ${this.tableName}
                 SET expires_at = $1, updated_at = now()
                 WHERE user_id = $2 AND session_id = $3`,
                [new Date(Date.now() + ttl * 1000).toISOString(), userId, sessionId]
            );
        }
    }

    async get(userId: string, sessionId: string): Promise<Session | null> {
        try {
            const rows = await this.sql.query(
                `SELECT * FROM ${this.tableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            ) as NeonSessionRow[];

            if (!rows[0]) return null;

            return this.mapRowToSessionData(rows[0]);
        } catch (error) {
            console.error('[NeonStorage] Failed to get session:', error);
            return null;
        }
    }

    async getCredentials(userId: string, sessionId: string): Promise<SessionCredentials | null> {
        try {
            const credentialRows = await this.sql.query(
                `SELECT * FROM ${this.credentialsTableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            ) as NeonCredentialsRow[];

            if (credentialRows[0]) {
                return this.mapRowToCredentials(credentialRows[0], userId, sessionId);
            }

            const sessionRows = await this.sql.query(
                `SELECT id FROM ${this.tableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            ) as Array<{ id: string }>;

            return sessionRows[0] ? { sessionId, userId } : null;
        } catch (error) {
            console.error('[NeonStorage] Failed to get credentials:', error);
            return null;
        }
    }

    async list(userId: string): Promise<Session[]> {
        try {
            const rows = await this.sql.query(
                `SELECT * FROM ${this.tableName} WHERE user_id = $1`,
                [userId]
            ) as NeonSessionRow[];
            return rows.map((row) => this.mapRowToSessionData(row));
        } catch (error) {
            console.error(`[NeonStorage] Failed to get session data for ${userId}:`, error);
            return [];
        }
    }

    async clearCredentials(userId: string, sessionId: string): Promise<void> {
        try {
            await this.sql.query(
                `DELETE FROM ${this.credentialsTableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            );
        } catch (error) {
            console.error('[NeonStorage] Failed to clear credentials:', error);
        }
    }

    async delete(userId: string, sessionId: string): Promise<void> {
        try {
            await this.sql.query(
                `DELETE FROM ${this.tableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            );
        } catch (error) {
            console.error('[NeonStorage] Failed to remove session:', error);
        }
    }

    async listIds(userId: string): Promise<string[]> {
        try {
            const rows = await this.sql.query(
                `SELECT session_id FROM ${this.tableName} WHERE user_id = $1`,
                [userId]
            ) as Array<{ session_id: string }>;
            return rows.map((row) => row.session_id);
        } catch (error) {
            console.error(`[NeonStorage] Failed to get sessions for ${userId}:`, error);
            return [];
        }
    }

    async listAllIds(): Promise<string[]> {
        try {
            const rows = await this.sql.query(
                `SELECT session_id FROM ${this.tableName}`
            ) as Array<{ session_id: string }>;
            return rows.map((row) => row.session_id);
        } catch (error) {
            console.error('[NeonStorage] Failed to get all sessions:', error);
            return [];
        }
    }

    async clearAll(): Promise<void> {
        try {
            await this.sql.query(`DELETE FROM ${this.credentialsTableName}`);
            await this.sql.query(`DELETE FROM ${this.tableName}`);
        } catch (error) {
            console.error('[NeonStorage] Failed to clear sessions:', error);
        }
    }

    async cleanupExpired(): Promise<void> {
        try {
            await this.sql.query(
                `DELETE FROM ${this.tableName} WHERE expires_at < $1`,
                [new Date().toISOString()]
            );
        } catch (error) {
            console.error('[NeonStorage] Failed to cleanup expired sessions:', error);
        }
    }

    async disconnect(): Promise<void> {
        // Neon HTTP queries do not hold a persistent connection.
    }
}
