import { test, expect } from '@playwright/test';
import { SupabaseStorageBackend } from '../../src/server/storage/supabase-backend';
import { createMockSession, createMockTokens } from '../test-utils';

/**
 * A mock Supabase client that faithfully simulates the fluent builder API:
 *   .from(table).update(data).eq(k,v).eq(k,v).select('id')
 *
 * Key insight: .select() called AFTER .update()/.delete() does NOT switch the
 * action — it sets `selectAfterMutation = true` so we return matched rows.
 */
function createMockSupabaseClient() {
    let sessions: any[] = [];

    return {
        /** Test-only helper to inspect internal state */
        _getSessions: () => sessions,

        from: (_table: string) => {
            let action: 'insert' | 'update' | 'select' | 'delete' | null = null;
            let payload: any = null;
            const filters: Array<(item: any) => boolean> = [];
            let selectAfterMutation = false;

            const chain: any = {
                insert: (data: any) => { action = 'insert'; payload = { ...data }; return chain; },
                update: (data: any) => { action = 'update'; payload = { ...data }; return chain; },
                delete: () => { action = 'delete'; return chain; },
                select: (_cols?: any) => {
                    // If called after update/delete → request rows back, not a fresh SELECT
                    if (action === 'update' || action === 'delete') {
                        selectAfterMutation = true;
                    } else {
                        action = 'select';
                    }
                    return chain;
                },
                eq:  (k: string, v: any) => { filters.push(row => row[k] === v);  return chain; },
                neq: (k: string, v: any) => { filters.push(row => row[k] !== v);  return chain; },
                lt:  (k: string, v: any) => {
                    filters.push(row => new Date(row[k]).getTime() < new Date(v).getTime());
                    return chain;
                },

                /** Used by getSession */
                maybeSingle: async () => {
                    let res = [...sessions];
                    for (const f of filters) res = res.filter(f);
                    return { data: res[0] ?? null, error: null };
                },

                /**
                 * Makes the chain awaitable — mimics the real Supabase PromiseLike
                 */
                then: (resolve: (v: any) => void, reject?: (e: any) => void) => {
                    try {
                        if (action === 'insert') {
                            if (sessions.some(s => s.session_id === payload.session_id)) {
                                return resolve({ data: null, error: { code: '23505', message: 'duplicate key violation' } });
                            }
                            sessions.push({ ...payload });
                            return resolve({ data: [payload], error: null });

                        } else if (action === 'update') {
                            const matched = sessions.filter(s => filters.every(f => f(s)));
                            matched.forEach(s => Object.assign(s, payload));
                            return resolve({ data: selectAfterMutation ? matched : null, error: null });

                        } else if (action === 'delete') {
                            const before = sessions.length;
                            sessions = sessions.filter(s => !filters.every(f => f(s)));
                            const removed = before - sessions.length;
                            return resolve({ data: selectAfterMutation ? Array(removed).fill(null) : null, error: null });

                        } else if (action === 'select') {
                            const res = sessions.filter(s => filters.every(f => f(s)));
                            return resolve({ data: res, error: null });

                        } else {
                            return resolve({ data: null, error: new Error('Unknown action') });
                        }
                    } catch (err) {
                        reject ? reject(err) : resolve({ data: null, error: err });
                    }
                },
            };
            return chain;
        },
    } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────
test.describe('SupabaseStorageBackend', () => {
    let mockSupabase: any;
    let storage: SupabaseStorageBackend;

    test.beforeEach(() => {
        mockSupabase = createMockSupabaseClient();
        storage    = new SupabaseStorageBackend(mockSupabase);
    });

    // ── generateSessionId ────────────────────────────────────────────────────
    test.describe('generateSessionId', () => {
        test('generates unique UUIDs', () => {
            const id1 = storage.generateSessionId();
            const id2 = storage.generateSessionId();
            expect(id1).not.toBe(id2);
            // UUIDv4 pattern
            expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        });
    });

    // ── createSession ────────────────────────────────────────────────────────
    test.describe('createSession', () => {
        test('maps all SessionData fields to snake_case columns', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            const row = mockSupabase._getSessions()[0];
            expect(row.session_id).toBe(session.sessionId);
            expect(row.identity).toBe(session.identity);
            expect(row.user_id).toBe(session.identity);   // RLS mirror
            expect(row.server_id).toBe(session.serverId);
            expect(row.server_name).toBe(session.serverName);
            expect(row.server_url).toBe(session.serverUrl);
            expect(row.transport_type).toBe(session.transportType);
            expect(row.callback_url).toBe(session.callbackUrl);
            expect(row.active).toBe(session.active);
        });

        test('sets expires_at correctly from TTL', async () => {
            const ttl = 3600;
            const before = Date.now();
            await storage.createSession(createMockSession(), ttl);

            const row = mockSupabase._getSessions()[0];
            const expiresMs = new Date(row.expires_at).getTime();
            expect(expiresMs).toBeGreaterThanOrEqual(before + ttl * 1000 - 100);
            expect(expiresMs).toBeLessThanOrEqual(Date.now() + ttl * 1000 + 100);
        });

        test('persists JSONB fields: tokens, headers, clientInformation', async () => {
            const tokens = createMockTokens();
            const session = createMockSession({
                tokens,
                headers: { Authorization: 'Bearer xyz' },
            });
            await storage.createSession(session);

            const row = mockSupabase._getSessions()[0];
            expect(row.tokens).toEqual(tokens);
            expect(row.headers).toEqual({ Authorization: 'Bearer xyz' });
        });

        test('throws on duplicate session (unique key violation)', async () => {
            const session = createMockSession();
            await storage.createSession(session);
            await expect(storage.createSession(session)).rejects.toThrow('already exists');
        });
    });

    // ── updateSession ────────────────────────────────────────────────────────
    test.describe('updateSession', () => {
        test('updates partial fields and preserves unchanged ones', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            const newTokens = createMockTokens();
            await storage.updateSession(session.identity, session.sessionId, {
                active: true,
                tokens: newTokens,
                transportType: 'streamable_http',
            });

            const retrieved = await storage.getSession(session.identity, session.sessionId);
            // Updated
            expect(retrieved?.active).toBe(true);
            expect(retrieved?.tokens).toEqual(newTokens);
            expect(retrieved?.transportType).toBe('streamable_http');
            // Preserved
            expect(retrieved?.serverId).toBe(session.serverId);
            expect(retrieved?.serverUrl).toBe(session.serverUrl);
            expect(retrieved?.identity).toBe(session.identity);
        });

        test('handles OAuth token refresh safely', async () => {
            const session = createMockSession({ tokens: createMockTokens() });
            await storage.createSession(session);

            const refreshed = createMockTokens({
                access_token:  'new-access-token',
                refresh_token: 'new-refresh-token',
            });
            await storage.updateSession(session.identity, session.sessionId, { tokens: refreshed });

            const retrieved = await storage.getSession(session.identity, session.sessionId);
            expect(retrieved?.tokens?.access_token).toBe('new-access-token');
            expect(retrieved?.tokens?.refresh_token).toBe('new-refresh-token');
        });

        test('refreshes expires_at with a new TTL', async () => {
            const session = createMockSession();
            await storage.createSession(session, 10);        // 10s TTL on create

            const before = Date.now();
            await storage.updateSession(session.identity, session.sessionId, { active: true }, 7200);

            const row = mockSupabase._getSessions()[0];
            const expiresMs = new Date(row.expires_at).getTime();
            // Should now be ~2 hours from now (not 10 seconds)
            expect(expiresMs).toBeGreaterThan(before + 7000 * 1000);
        });

        test('throws if session does not exist', async () => {
            await expect(
                storage.updateSession('no-user', 'no-session', { active: true })
            ).rejects.toThrow('not found');
        });
    });

    // ── getSession ───────────────────────────────────────────────────────────
    test.describe('getSession', () => {
        test('maps DB row back to camelCase SessionData correctly', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            const result = await storage.getSession(session.identity, session.sessionId);

            expect(result).not.toBeNull();
            expect(result?.sessionId).toBe(session.sessionId);
            expect(result?.serverId).toBe(session.serverId);
            expect(result?.serverName).toBe(session.serverName);
            expect(result?.serverUrl).toBe(session.serverUrl);
            expect(result?.transportType).toBe(session.transportType);
            expect(result?.callbackUrl).toBe(session.callbackUrl);
            expect(result?.identity).toBe(session.identity);
            expect(result?.active).toBe(session.active);
            expect(typeof result?.createdAt).toBe('number');
        });

        test('returns null when session does not exist', async () => {
            expect(await storage.getSession('ghost', 'ghost')).toBeNull();
        });

        test('does not leak sessions across identities', async () => {
            const a = createMockSession({ sessionId: 'a', identity: 'user-a' });
            const b = createMockSession({ sessionId: 'b', identity: 'user-b' });
            await storage.createSession(a);
            await storage.createSession(b);

            // user-a queries for user-b's session ID → should get null
            expect(await storage.getSession('user-a', 'b')).toBeNull();
        });
    });

    // ── removeSession ────────────────────────────────────────────────────────
    test.describe('removeSession', () => {
        test('deletes the session so it can no longer be retrieved', async () => {
            const session = createMockSession();
            await storage.createSession(session);
            await storage.removeSession(session.identity, session.sessionId);
            expect(await storage.getSession(session.identity, session.sessionId)).toBeNull();
        });

        test('does not remove other sessions belonging to the same identity', async () => {
            const identity = 'multi-user';
            await storage.createSession(createMockSession({ sessionId: 's1', identity }));
            await storage.createSession(createMockSession({ sessionId: 's2', identity }));

            await storage.removeSession(identity, 's1');

            const remaining = await storage.getIdentityMcpSessions(identity);
            expect(remaining).toEqual(['s2']);
        });
    });

    // ── getIdentitySessionsData ──────────────────────────────────────────────
    test.describe('getIdentitySessionsData', () => {
        test('returns all full SessionData objects for the identity', async () => {
            const identity = 'owner';
            await storage.createSession(createMockSession({ sessionId: 'x1', identity }));
            await storage.createSession(createMockSession({ sessionId: 'x2', identity, serverName: 'Alt Server' }));
            // Another user — must NOT appear
            await storage.createSession(createMockSession({ sessionId: 'x3', identity: 'intruder' }));

            const sessions = await storage.getIdentitySessionsData(identity);
            expect(sessions.length).toBe(2);
            expect(sessions.map(s => s.sessionId)).toContain('x1');
            expect(sessions.map(s => s.sessionId)).toContain('x2');
        });

        test('returns empty array for identity with no sessions', async () => {
            expect(await storage.getIdentitySessionsData('nobody')).toEqual([]);
        });
    });

    // ── getIdentityMcpSessions ───────────────────────────────────────────────
    test.describe('getIdentityMcpSessions', () => {
        test('returns only session IDs (not full objects)', async () => {
            const identity = 'slim-user';
            await storage.createSession(createMockSession({ sessionId: 'id-a', identity }));
            await storage.createSession(createMockSession({ sessionId: 'id-b', identity }));

            const ids = await storage.getIdentityMcpSessions(identity);
            expect(ids.sort()).toEqual(['id-a', 'id-b']);
        });
    });

    // ── getAllSessionIds ──────────────────────────────────────────────────────
    test.describe('getAllSessionIds', () => {
        test('returns session IDs across ALL identities', async () => {
            await storage.createSession(createMockSession({ sessionId: 'g1', identity: 'u1' }));
            await storage.createSession(createMockSession({ sessionId: 'g2', identity: 'u2' }));

            const ids = await storage.getAllSessionIds();
            expect(ids).toContain('g1');
            expect(ids).toContain('g2');
            expect(ids.length).toBe(2);
        });
    });

    // ── clearAll ─────────────────────────────────────────────────────────────
    test.describe('clearAll', () => {
        test('wipes every session regardless of identity', async () => {
            await storage.createSession(createMockSession({ sessionId: 'c1', identity: 'u1' }));
            await storage.createSession(createMockSession({ sessionId: 'c2', identity: 'u2' }));

            await storage.clearAll();

            expect(await storage.getAllSessionIds()).toEqual([]);
        });
    });

    // ── cleanupExpiredSessions ───────────────────────────────────────────────
    test.describe('cleanupExpiredSessions', () => {
        test('deletes rows where expires_at is in the past', async () => {
            await storage.createSession(createMockSession({ sessionId: 'alive' }),  3600);  // future
            await storage.createSession(createMockSession({ sessionId: 'zombie' }), -3600); // past

            await storage.cleanupExpiredSessions();

            const rows = mockSupabase._getSessions();
            expect(rows.length).toBe(1);
            expect(rows[0].session_id).toBe('alive');
        });

        test('is a no-op when there are no expired sessions', async () => {
            await storage.createSession(createMockSession({ sessionId: 'fresh' }), 3600);
            await storage.cleanupExpiredSessions();
            expect(mockSupabase._getSessions().length).toBe(1);
        });
    });

    // ── disconnect ───────────────────────────────────────────────────────────
    test.describe('disconnect', () => {
        test('resolves cleanly (no persistent connection to close)', async () => {
            await expect(storage.disconnect()).resolves.toBeUndefined();
        });
    });
});
