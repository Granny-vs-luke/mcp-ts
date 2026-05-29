import { test, expect } from '@playwright/test';
import { NeonStorageBackend } from '../../src/server/storage/neon-backend';
import { createMockSession, createMockTokens } from '../test-utils';

type NeonRow = {
    id: string;
    session_id: string;
    user_id: string;
    server_id?: string;
    server_name?: string;
    server_url: string;
    transport_type: 'sse' | 'streamable-http';
    callback_url: string;
    created_at: string;
    updated_at: string;
    expires_at: string;
    active: boolean;
    headers?: Record<string, string>;
    auth_url?: string | null;
};

type NeonCredentialsRow = {
    id: string;
    session_id: string;
    user_id: string;
    client_information?: unknown;
    tokens?: unknown;
    code_verifier?: unknown;
    client_id?: string | null;
    oauth_state?: unknown;
};

function createMockNeonSql() {
    let sessions: NeonRow[] = [];
    let credentials: NeonCredentialsRow[] = [];
    let simulateMissingTable = false;

    const query = async (text: string, params: unknown[] = []) => {
        const normalized = text.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

        if (normalized.includes('to_regclass')) {
            return [{ exists: simulateMissingTable ? null : 'public.mcp_sessions' }];
        }

        if (normalized.startsWith('insert into public.mcp_sessions')) {
            const [
                sessionId,
                userId,
                serverId,
                serverName,
                serverUrl,
                transportType,
                callbackUrl,
                createdAt,
                headers,
                authUrl,
                active,
                expiresAt,
            ] = params;

            if (sessions.some((row) => row.session_id === sessionId)) {
                const error = new Error('duplicate key value violates unique constraint');
                (error as Error & { code?: string }).code = '23505';
                throw error;
            }

            sessions.push({
                id: `row-${sessions.length + 1}`,
                session_id: sessionId as string,
                user_id: userId as string,
                server_id: serverId as string | undefined,
                server_name: serverName as string | undefined,
                server_url: serverUrl as string,
                transport_type: transportType as 'sse' | 'streamable-http',
                callback_url: callbackUrl as string,
                created_at: createdAt as string,
                updated_at: new Date().toISOString(),
                expires_at: expiresAt as string,
                active: active as boolean,
                headers: headers as Record<string, string> | undefined,
                auth_url: authUrl as string | null,
            });
            return [];
        }

        if (normalized.startsWith('insert into public.mcp_credentials')) {
            const [
                userId,
                sessionId,
                clientInformation,
                tokens,
                codeVerifier,
                clientId,
                oauthState,
                hasClientInformation,
                hasTokens,
                hasCodeVerifier,
                hasClientId,
                hasOauthState,
            ] = params;

            let row = credentials.find((item) => item.user_id === userId && item.session_id === sessionId);
            if (!row) {
                row = {
                    id: `credentials-${credentials.length + 1}`,
                    user_id: userId as string,
                    session_id: sessionId as string,
                };
                credentials.push(row);
            }

            if (hasClientInformation) row.client_information = clientInformation;
            if (hasTokens) row.tokens = tokens;
            if (hasCodeVerifier) row.code_verifier = codeVerifier;
            if (hasClientId) row.client_id = clientId as string | null;
            if (hasOauthState) row.oauth_state = oauthState;
            return [];
        }

        if (normalized.startsWith('update public.mcp_sessions') && normalized.includes('set server_id')) {
            const [
                serverId,
                serverName,
                serverUrl,
                transportType,
                callbackUrl,
                active,
                headers,
                authUrl,
                expiresAt,
                userId,
                sessionId,
            ] = params;
            const row = sessions.find((item) => item.user_id === userId && item.session_id === sessionId);
            if (!row) {
                return [];
            }

            row.server_id = serverId as string | undefined;
            row.server_name = serverName as string | undefined;
            row.server_url = serverUrl as string;
            row.transport_type = transportType as 'sse' | 'streamable-http';
            row.callback_url = callbackUrl as string;
            row.active = active as boolean;
            row.headers = headers as Record<string, string> | undefined;
            row.auth_url = authUrl as string | null;
            row.expires_at = expiresAt as string;
            row.updated_at = new Date().toISOString();
            return [{ id: row.id }];
        }

        if (normalized.startsWith('update public.mcp_sessions') && normalized.includes('set expires_at')) {
            const [expiresAt, userId, sessionId] = params;
            const row = sessions.find((item) => item.user_id === userId && item.session_id === sessionId);
            if (row) {
                row.expires_at = expiresAt as string;
                row.updated_at = new Date().toISOString();
            }
            return [];
        }

        if (normalized.startsWith('select * from public.mcp_sessions where user_id = $1 and session_id = $2')) {
            const [userId, sessionId] = params;
            return sessions.filter((row) => row.user_id === userId && row.session_id === sessionId);
        }

        if (normalized.startsWith('select * from public.mcp_credentials where user_id = $1 and session_id = $2')) {
            const [userId, sessionId] = params;
            return credentials.filter((row) => row.user_id === userId && row.session_id === sessionId);
        }

        if (normalized.startsWith('select id from public.mcp_sessions where user_id = $1 and session_id = $2')) {
            const [userId, sessionId] = params;
            return sessions
                .filter((row) => row.user_id === userId && row.session_id === sessionId)
                .map((row) => ({ id: row.id }));
        }

        if (normalized.startsWith('select * from public.mcp_sessions where user_id = $1')) {
            const [userId] = params;
            return sessions.filter((row) => row.user_id === userId);
        }

        if (normalized.startsWith('select session_id from public.mcp_sessions where user_id = $1')) {
            const [userId] = params;
            return sessions
                .filter((row) => row.user_id === userId)
                .map((row) => ({ session_id: row.session_id }));
        }

        if (normalized.startsWith('select session_id from public.mcp_sessions')) {
            return sessions.map((row) => ({ session_id: row.session_id }));
        }

        if (normalized.startsWith('delete from public.mcp_sessions where user_id = $1 and session_id = $2')) {
            const [userId, sessionId] = params;
            sessions = sessions.filter((row) => !(row.user_id === userId && row.session_id === sessionId));
            credentials = credentials.filter((row) => !(row.user_id === userId && row.session_id === sessionId));
            return [];
        }

        if (normalized.startsWith('delete from public.mcp_credentials where user_id = $1 and session_id = $2')) {
            const [userId, sessionId] = params;
            credentials = credentials.filter((row) => !(row.user_id === userId && row.session_id === sessionId));
            return [];
        }

        if (normalized.startsWith('delete from public.mcp_sessions where expires_at <')) {
            const [expiresAt] = params;
            sessions = sessions.filter((row) => new Date(row.expires_at).getTime() >= new Date(expiresAt as string).getTime());
            return [];
        }

        if (normalized.startsWith('delete from public.mcp_sessions')) {
            sessions = [];
            return [];
        }

        if (normalized.startsWith('delete from public.mcp_credentials')) {
            credentials = [];
            return [];
        }

        throw new Error(`Unexpected query: ${text}`);
    };

    return {
        sql: { query },
        listSessions: () => sessions,
        listCredentials: () => credentials,
        setMissingTable: (value: boolean) => {
            simulateMissingTable = value;
        },
    };
}

test.describe('NeonStorageBackend', () => {
    let mockNeon: ReturnType<typeof createMockNeonSql>;
    let storage: NeonStorageBackend;

    test.beforeEach(() => {
        mockNeon = createMockNeonSql();
        storage = new NeonStorageBackend(mockNeon.sql);
    });

    test('initializes when the mcp_sessions table exists', async () => {
        await expect(storage.init()).resolves.toBeUndefined();
    });

    test('throws a helpful error when the mcp_sessions table is missing', async () => {
        mockNeon.setMissingTable(true);

        await expect(storage.init()).rejects.toThrow(/Table "mcp_sessions" not found/);
        await expect(storage.init()).rejects.toThrow(/Neon storage guide/);
    });

    test('stores and retrieves a session', async () => {
        const oauthState = {
            nonce: 'nonce-1',
            sessionId: 'test-session-123',
            serverId: 'test-server',
            createdAt: Date.now(),
        };
        const tokens = createMockTokens();
        const session = createMockSession({ headers: { Authorization: 'Bearer test' } });

        await storage.create(session);
        await storage.patchCredentials(session.userId, session.sessionId, { tokens, oauthState });

        const retrieved = await storage.get(session.userId, session.sessionId);
        const credentials = await storage.getCredentials(session.userId, session.sessionId);
        expect(retrieved?.sessionId).toBe(session.sessionId);
        expect(retrieved?.userId).toBe(session.userId);
        expect((retrieved as any)?.tokens).toBeUndefined();
        expect(credentials?.tokens).toEqual(tokens);
        expect(retrieved?.headers).toEqual(session.headers);
        expect(credentials?.oauthState).toEqual(oauthState);
    });

    test('throws if a session already exists', async () => {
        const session = createMockSession();
        await storage.create(session);

        await expect(storage.create(session)).rejects.toThrow('already exists');
    });

    test('updates partial session data while preserving unchanged fields', async () => {
        const session = createMockSession();
        await storage.create(session);

        const tokens = createMockTokens({ access_token: 'refreshed-token' });
        await storage.update(session.userId, session.sessionId, { active: false, transportType: 'streamable-http' });
        await storage.patchCredentials(session.userId, session.sessionId, { tokens });

        const retrieved = await storage.get(session.userId, session.sessionId);
        const credentials = await storage.getCredentials(session.userId, session.sessionId);
        expect(retrieved?.active).toBe(false);
        expect((retrieved as any)?.tokens).toBeUndefined();
        expect(credentials?.tokens).toEqual(tokens);
        expect(retrieved?.transportType).toBe('streamable-http');
        expect(retrieved?.serverUrl).toBe(session.serverUrl);
    });

    test('throws when updating a missing session', async () => {
        await expect(
            storage.update('missing-user', 'missing-session', { active: true })
        ).rejects.toThrow('not found');
    });

    test('lists, removes, clears, and cleans up sessions', async () => {
        await storage.create(createMockSession({ sessionId: 'a', userId: 'user-a' }), 3600);
        await storage.create(createMockSession({ sessionId: 'b', userId: 'user-a' }), -1);
        await storage.create(createMockSession({ sessionId: 'c', userId: 'user-b' }), 3600);

        expect((await storage.listIds('user-a')).sort()).toEqual(['a', 'b']);
        expect((await storage.listAllIds()).sort()).toEqual(['a', 'b', 'c']);

        await storage.cleanupExpired();
        expect((await storage.listAllIds()).sort()).toEqual(['a', 'c']);

        await storage.delete('user-a', 'a');
        expect(await storage.get('user-a', 'a')).toBeNull();

        await storage.clearAll();
        expect(await storage.list('user-b')).toEqual([]);
        expect(mockNeon.listSessions()).toEqual([]);
    });
});
