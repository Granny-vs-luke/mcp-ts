import { test, expect } from '@playwright/test';
import { NeonStorageBackend } from '../../src/server/storage/neon-backend';
import { createMockSession, createMockTokens } from '../test-utils';
import { DORMANT_SESSION_EXPIRATION_MS, STATE_EXPIRATION_MS } from '../../src/shared/constants';
import type { SessionStatus } from '../../src/server/storage/types';

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
    expires_at: string | null;
    status: SessionStatus;
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
                updatedAt,
                headers,
                authUrl,
                status,
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
                updated_at: updatedAt as string,
                expires_at: expiresAt as string | null,
                status: status as SessionStatus,
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
            const whereUserId = params[params.length - 2] as string;
            const whereSessionId = params[params.length - 1] as string;
            const row = sessions.find((item) => item.user_id === whereUserId && item.session_id === whereSessionId);
            if (!row) {
                return [];
            }

            row.server_id = params[0] as string | undefined;
            row.server_name = params[1] as string | undefined;
            row.server_url = params[2] as string;
            row.transport_type = params[3] as 'sse' | 'streamable-http';
            row.callback_url = params[4] as string;
            row.status = params[5] as SessionStatus;
            row.headers = params[6] as Record<string, string> | undefined;
            row.auth_url = params[7] as string | null;
            row.expires_at = params[8] as string | null;
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

        if (normalized.startsWith('delete from public.mcp_sessions where expires_at is not null')) {
            const [expiresAt] = params;
            sessions = sessions.filter((row) => (
                row.status === 'active' ||
                row.expires_at === null ||
                new Date(row.expires_at).getTime() >= new Date(expiresAt as string).getTime()
            ));
            return [];
        }

        if (normalized.startsWith("delete from public.mcp_sessions where status = 'active'")) {
            const [updatedAt] = params;
            sessions = sessions.filter((row) => (
                row.status !== 'active' ||
                new Date(row.updated_at).getTime() >= new Date(updatedAt as string).getTime()
            ));
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
        await storage.update(session.userId, session.sessionId, { status: 'pending', transportType: 'streamable-http' });
        await storage.patchCredentials(session.userId, session.sessionId, { tokens });

        const retrieved = await storage.get(session.userId, session.sessionId);
        const credentials = await storage.getCredentials(session.userId, session.sessionId);
        expect(retrieved?.status).toBe('pending');
        expect((retrieved as any)?.tokens).toBeUndefined();
        expect(credentials?.tokens).toEqual(tokens);
        expect(retrieved?.transportType).toBe('streamable-http');
        expect(retrieved?.serverUrl).toBe(session.serverUrl);
    });

    test('throws when updating a missing session', async () => {
        await expect(
            storage.update('missing-user', 'missing-session', { status: 'active' })
        ).rejects.toThrow('not found');
    });

    test('lists, removes, clears, and cleans up sessions', async () => {
        await storage.create(createMockSession({ sessionId: 'a', userId: 'user-a' }));
        await storage.create(createMockSession({
            sessionId: 'b',
            userId: 'user-a',
            status: 'pending',
            createdAt: Date.now() - STATE_EXPIRATION_MS - 1000,
        }));
        await storage.create(createMockSession({ sessionId: 'c', userId: 'user-b' }));

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

    // ── generateSessionId ────────────────────────────────────────────────
    test.describe('generateSessionId', () => {
        test('generates unique UUIDs', () => {
            const id1 = storage.generateSessionId();
            const id2 = storage.generateSessionId();
            expect(id1).not.toBe(id2);
            expect(id1).toMatch(/^sess_[a-zA-Z0-9]{21}$/);
        });
    });

    // ── create field mapping ─────────────────────────────────────────────
    test.describe('create', () => {
        test('maps all Session fields to snake_case columns', async () => {
            const session = createMockSession();
            await storage.create(session);

            const rows = mockNeon.listSessions();
            expect(rows.length).toBe(1);
            const row = rows[0];
            expect(row.session_id).toBe(session.sessionId);
            expect(row.user_id).toBe(session.userId);
            expect(row.server_id).toBe(session.serverId);
            expect(row.server_name).toBe(session.serverName);
            expect(row.server_url).toBe(session.serverUrl);
            expect(row.transport_type).toBe(session.transportType);
            expect(row.callback_url).toBe(session.callbackUrl);
            expect(row.status).toBe(session.status);
        });

        test('sets short expires_at for pending sessions', async () => {
            const before = Date.now();
            await storage.create(createMockSession({ status: 'pending' }));

            const rows = mockNeon.listSessions();
            const expiresMs = new Date(rows[0].expires_at!).getTime();
            expect(expiresMs).toBeGreaterThanOrEqual(before + STATE_EXPIRATION_MS - 100);
            expect(expiresMs).toBeLessThanOrEqual(Date.now() + STATE_EXPIRATION_MS + 100);
        });

        test('leaves expires_at null for active sessions', async () => {
            await storage.create(createMockSession({ status: 'active' }));

            const rows = mockNeon.listSessions();
            expect(rows[0].expires_at).toBeNull();
        });

        test('keeps headers on session and tokens in credentials', async () => {
            const tokens = createMockTokens();
            const oauthState = {
                nonce: 'nonce-1',
                sessionId: 'test-session-123',
                serverId: 'test-server',
                createdAt: Date.now(),
            };
            const session = createMockSession({ headers: { Authorization: 'Bearer xyz' } });
            await storage.create(session);
            await storage.patchCredentials(session.userId, session.sessionId, { tokens, oauthState });

            const sessionRows = mockNeon.listSessions();
            const credentialRows = mockNeon.listCredentials();
            expect((sessionRows[0] as any).tokens).toBeUndefined();
            expect(sessionRows[0].headers).toEqual({ Authorization: 'Bearer xyz' });
            expect(credentialRows[0].tokens).toEqual(tokens);
            expect(credentialRows[0].oauth_state).toEqual(oauthState);
        });
    });

    // ── get ──────────────────────────────────────────────────────────────
    test.describe('get', () => {
        test('maps DB row back to camelCase Session correctly', async () => {
            const session = createMockSession();
            await storage.create(session);

            const result = await storage.get(session.userId, session.sessionId);
            expect(result).not.toBeNull();
            expect(result?.sessionId).toBe(session.sessionId);
            expect(result?.serverId).toBe(session.serverId);
            expect(result?.serverName).toBe(session.serverName);
            expect(result?.serverUrl).toBe(session.serverUrl);
            expect(result?.transportType).toBe(session.transportType);
            expect(result?.callbackUrl).toBe(session.callbackUrl);
            expect(result?.userId).toBe(session.userId);
            expect(result?.status).toBe(session.status);
            expect(typeof result?.createdAt).toBe('number');
        });

        test('returns null when session does not exist', async () => {
            expect(await storage.get('ghost', 'ghost')).toBeNull();
        });

        test('does not leak sessions across userIds', async () => {
            await storage.create(createMockSession({ sessionId: 'a', userId: 'user-a' }));
            await storage.create(createMockSession({ sessionId: 'b', userId: 'user-b' }));

            expect(await storage.get('user-a', 'b')).toBeNull();
        });
    });

    // ── delete ───────────────────────────────────────────────────────────
    test.describe('delete', () => {
        test('does not remove other sessions belonging to the same userId', async () => {
            const userId = 'multi-user';
            await storage.create(createMockSession({ sessionId: 's1', userId }));
            await storage.create(createMockSession({ sessionId: 's2', userId }));

            await storage.delete(userId, 's1');

            const remaining = await storage.listIds(userId);
            expect(remaining).toEqual(['s2']);
        });
    });

    // ── listIds ──────────────────────────────────────────────────────────
    test.describe('listIds', () => {
        test('returns only session IDs (not full objects)', async () => {
            const userId = 'slim-user';
            await storage.create(createMockSession({ sessionId: 'id-a', userId }));
            await storage.create(createMockSession({ sessionId: 'id-b', userId }));

            const ids = await storage.listIds(userId);
            expect(ids.sort()).toEqual(['id-a', 'id-b']);
        });
    });

    // ── clearCredentials ─────────────────────────────────────────────────
    test.describe('clearCredentials', () => {
        test('removes credentials row while session remains intact', async () => {
            const session = createMockSession();
            const tokens = createMockTokens();
            await storage.create(session);
            await storage.patchCredentials(session.userId, session.sessionId, { tokens });

            expect(mockNeon.listCredentials().length).toBe(1);

            await storage.clearCredentials(session.userId, session.sessionId);

            const credentials = await storage.getCredentials(session.userId, session.sessionId);
            const retrieved = await storage.get(session.userId, session.sessionId);
            expect(credentials?.tokens).toBeUndefined();
            expect(retrieved).not.toBeNull();
            expect(mockNeon.listCredentials().length).toBe(0);
        });
    });

    // ── update credential ops ────────────────────────────────────────────
    test.describe('update', () => {
        test('clears OAuth tokens when credentials are invalidated', async () => {
            const session = createMockSession();
            await storage.create(session);
            await storage.patchCredentials(session.userId, session.sessionId, { tokens: createMockTokens() });

            await storage.patchCredentials(session.userId, session.sessionId, { tokens: null });

            const rows = mockNeon.listCredentials();
            const credentials = await storage.getCredentials(session.userId, session.sessionId);
            expect(rows[0].tokens).toBeNull();
            expect(credentials?.tokens).toBeNull();
        });

        test('promotion to active clears expires_at', async () => {
            const session = createMockSession({ status: 'pending' });
            await storage.create(session);
            expect(mockNeon.listSessions()[0].expires_at).not.toBeNull();

            await storage.update(session.userId, session.sessionId, { status: 'active' });

            const row = mockNeon.listSessions()[0];
            expect(row.expires_at).toBeNull();
        });
    });

    // ── cleanupExpired (dormant active) ──────────────────────────────────
    test.describe('cleanupExpired', () => {
        test('deletes dormant active sessions by updated_at', async () => {
            await storage.create(createMockSession({
                sessionId: 'dormant',
                status: 'active',
                updatedAt: Date.now() - DORMANT_SESSION_EXPIRATION_MS - 1000,
            }));

            await storage.cleanupExpired();

            expect(mockNeon.listSessions()).toEqual([]);
        });
    });

    // ── disconnect ───────────────────────────────────────────────────────
    test.describe('disconnect', () => {
        test('resolves cleanly (no persistent connection to close)', async () => {
            await expect(storage.disconnect()).resolves.toBeUndefined();
        });
    });
});
