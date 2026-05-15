import { StorageBackend, SessionData } from './types.js';
import { SESSION_TTL_SECONDS } from '../../shared/constants.js';
import { generateSessionId } from '../../shared/utils.js';
import { encryptObject, decryptObject } from './crypto.js';

export interface NeonStorageOptions {
    schema?: string;
    table?: string;
}

type NeonSql = {
    query(queryWithPlaceholders: string, params?: unknown[]): Promise<any[]>;
};

type NeonSessionRow = {
    session_id: string;
    server_id?: string | null;
    server_name?: string | null;
    server_url: string;
    transport_type: 'sse' | 'streamable-http';
    callback_url: string;
    created_at: string | Date;
    user_id: string;
    headers?: unknown;
    active?: boolean | null;
    client_information?: unknown;
    tokens?: unknown;
    code_verifier?: string | null;
    client_id?: string | null;
};

export class NeonStorageBackend implements StorageBackend {
    private readonly DEFAULT_TTL = SESSION_TTL_SECONDS;
    private readonly tableName: string;

    constructor(
        private readonly sql: NeonSql,
        options: NeonStorageOptions = {}
    ) {
        const schema = options.schema || 'public';
        const table = options.table || 'mcp_sessions';
        this.tableName = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`;
    }

    async init(): Promise<void> {
        const [{ exists } = { exists: null }] = await this.sql.query(
            'SELECT to_regclass($1) AS exists',
            [this.tableName.replace(/"/g, '')]
        ) as Array<{ exists: string | null }>;

        if (!exists) {
            throw new Error(
                '[NeonStorage] Table "mcp_sessions" not found in your database. ' +
                'Please create it using the Neon storage guide in docs/storage-backends/neon.md.'
            );
        }

        console.log('[mcp-ts][Storage] Neon: "mcp_sessions" table verified.');
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

    private mapRowToSessionData(row: NeonSessionRow): SessionData {
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
            active: row.active ?? false,
            clientInformation: row.client_information as SessionData['clientInformation'],
            tokens: decryptObject(row.tokens),
            codeVerifier: row.code_verifier ?? undefined,
            clientId: row.client_id ?? undefined,
        };
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
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
                    active,
                    client_information,
                    tokens,
                    code_verifier,
                    client_id,
                    expires_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12, $13, $14, $15
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
                    session.active ?? false,
                    session.clientInformation,
                    encryptObject(session.tokens),
                    session.codeVerifier,
                    session.clientId,
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

    async updateSession(userId: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
        const currentSession = await this.getSession(userId, sessionId);
        if (!currentSession) {
            throw new Error(`Session ${sessionId} not found for userId ${userId}`);
        }

        const updatedSession = { ...currentSession, ...data };
        const effectiveTtl = ttl ?? this.DEFAULT_TTL;
        const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString();

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
                client_information = $8,
                tokens = $9,
                code_verifier = $10,
                client_id = $11,
                expires_at = $12,
                updated_at = now()
             WHERE user_id = $13 AND session_id = $14
             RETURNING id`,
            [
                updatedSession.serverId,
                updatedSession.serverName,
                updatedSession.serverUrl,
                updatedSession.transportType,
                updatedSession.callbackUrl,
                updatedSession.active ?? false,
                encryptObject(updatedSession.headers),
                updatedSession.clientInformation,
                encryptObject(updatedSession.tokens),
                updatedSession.codeVerifier,
                updatedSession.clientId,
                expiresAt,
                userId,
                sessionId,
            ]
        ) as Array<{ id: string }>;

        if (updatedRows.length === 0) {
            throw new Error(`Session ${sessionId} not found for userId ${userId}`);
        }
    }

    async getSession(userId: string, sessionId: string): Promise<SessionData | null> {
        try {
            const rows = await this.sql.query(
                `SELECT * FROM ${this.tableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            ) as NeonSessionRow[];
            return rows[0] ? this.mapRowToSessionData(rows[0]) : null;
        } catch (error) {
            console.error('[NeonStorage] Failed to get session:', error);
            return null;
        }
    }

    async listSessions(userId: string): Promise<SessionData[]> {
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

    async deleteSession(userId: string, sessionId: string): Promise<void> {
        try {
            await this.sql.query(
                `DELETE FROM ${this.tableName} WHERE user_id = $1 AND session_id = $2`,
                [userId, sessionId]
            );
        } catch (error) {
            console.error('[NeonStorage] Failed to remove session:', error);
        }
    }

    async listSessionIds(userId: string): Promise<string[]> {
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

    async listGlobalSessionIds(): Promise<string[]> {
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

    async clearGlobalSessions(): Promise<void> {
        try {
            await this.sql.query(`DELETE FROM ${this.tableName}`);
        } catch (error) {
            console.error('[NeonStorage] Failed to clear sessions:', error);
        }
    }

    async cleanupExpiredSessions(): Promise<void> {
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
