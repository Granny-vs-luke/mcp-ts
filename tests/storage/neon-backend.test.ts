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
    client_information?: unknown;
    tokens?: unknown;
    code_verifier?: string;
    client_id?: string;
};

function createMockNeonSql() {
    let sessions: NeonRow[] = [];
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
                active,
                clientInformation,
                tokens,
                codeVerifier,
                clientId,
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
                client_information: clientInformation,
                tokens,
                code_verifier: codeVerifier as string | undefined,
                client_id: clientId as string | undefined,
            });
            return [];
        }

        if (normalized.startsWith('update public.mcp_sessions')) {
            const [
                serverId,
                serverName,
                serverUrl,
                transportType,
                callbackUrl,
                active,
                headers,
                clientInformation,
                tokens,
                codeVerifier,
                clientId,
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
            row.client_information = clientInformation;
            row.tokens = tokens;
            row.code_verifier = codeVerifier as string | undefined;
            row.client_id = clientId as string | undefined;
            row.expires_at = expiresAt as string;
            row.updated_at = new Date().toISOString();
            return [{ id: row.id }];
        }

        if (normalized.startsWith('select * from public.mcp_sessions where user_id = $1 and session_id = $2')) {
            const [userId, sessionId] = params;
            return sessions.filter((row) => row.user_id === userId && row.session_id === sessionId);
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

        throw new Error(`Unexpected query: ${text}`);
    };

    return {
        sql: { query },
        listSessions: () => sessions,
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
        const session = createMockSession({
            tokens: createMockTokens(),
            headers: { Authorization: 'Bearer test' },
        });

        await storage.createSession(session);

        const retrieved = await storage.getSession(session.userId, session.sessionId);
        expect(retrieved?.sessionId).toBe(session.sessionId);
        expect(retrieved?.userId).toBe(session.userId);
        expect(retrieved?.tokens).toEqual(session.tokens);
        expect(retrieved?.headers).toEqual(session.headers);
    });

    test('throws if a session already exists', async () => {
        const session = createMockSession();
        await storage.createSession(session);

        await expect(storage.createSession(session)).rejects.toThrow('already exists');
    });

    test('updates partial session data while preserving unchanged fields', async () => {
        const session = createMockSession();
        await storage.createSession(session);

        const tokens = createMockTokens({ access_token: 'refreshed-token' });
        await storage.updateSession(session.userId, session.sessionId, {
            active: false,
            tokens,
            transportType: 'streamable-http',
        });

        const retrieved = await storage.getSession(session.userId, session.sessionId);
        expect(retrieved?.active).toBe(false);
        expect(retrieved?.tokens).toEqual(tokens);
        expect(retrieved?.transportType).toBe('streamable-http');
        expect(retrieved?.serverUrl).toBe(session.serverUrl);
    });

    test('throws when updating a missing session', async () => {
        await expect(
            storage.updateSession('missing-user', 'missing-session', { active: true })
        ).rejects.toThrow('not found');
    });

    test('lists, removes, clears, and cleans up sessions', async () => {
        await storage.createSession(createMockSession({ sessionId: 'a', userId: 'user-a' }), 3600);
        await storage.createSession(createMockSession({ sessionId: 'b', userId: 'user-a' }), -1);
        await storage.createSession(createMockSession({ sessionId: 'c', userId: 'user-b' }), 3600);

        expect((await storage.listSessionIds('user-a')).sort()).toEqual(['a', 'b']);
        expect((await storage.listGlobalSessionIds()).sort()).toEqual(['a', 'b', 'c']);

        await storage.cleanupExpiredSessions();
        expect((await storage.listGlobalSessionIds()).sort()).toEqual(['a', 'c']);

        await storage.deleteSession('user-a', 'a');
        expect(await storage.getSession('user-a', 'a')).toBeNull();

        await storage.clearGlobalSessions();
        expect(await storage.listSessions('user-b')).toEqual([]);
        expect(mockNeon.listSessions()).toEqual([]);
    });
});
