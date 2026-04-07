/**
 * Unit tests for LocalStorageBackend
 *
 * Uses a hand-rolled in-memory localStorage mock so these tests run identically
 * in Node (Playwright / Vitest / Jest) without a browser.
 */
import { test, expect } from '@playwright/test';
import { LocalStorageBackend } from '../../src/client/storage/localstorage-backend';
import { createMockSession, createMockTokens, createMockClientInfo } from '../test-utils';

// ─── localStorage mock ───────────────────────────────────────────────────────

class LocalStorageMock implements Storage {
    private store: Map<string, string> = new Map();

    get length(): number {
        return this.store.size;
    }
    key(index: number): string | null {
        return Array.from(this.store.keys())[index] ?? null;
    }
    getItem(key: string): string | null {
        return this.store.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.store.set(key, value);
    }
    removeItem(key: string): void {
        this.store.delete(key);
    }
    clear(): void {
        this.store.clear();
    }
}

/** Install/uninstall the localStorage mock on the global object. */
function installLocalStorage(): LocalStorageMock {
    const mock = new LocalStorageMock();
    (globalThis as any).window = { localStorage: mock };
    return mock;
}

function uninstallLocalStorage(): void {
    delete (globalThis as any).window;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe('LocalStorageBackend', () => {
    let backend: LocalStorageBackend;

    test.beforeEach(() => {
        installLocalStorage();
        backend = new LocalStorageBackend({ namespace: 'test' });
    });

    test.afterEach(() => {
        uninstallLocalStorage();
    });

    // ─── init ────────────────────────────────────────────────────────────────

    test.describe('init()', () => {
        test('should initialize successfully in a browser environment', async () => {
            await expect(backend.init()).resolves.toBeUndefined();
        });

        test('should print a confirmation message to the console', async () => {
            const logs: string[] = [];
            const originalLog = console.log;
            console.log = (...args: any[]) => logs.push(args.join(' '));
            try {
                await backend.init();
                expect(logs.some(l => l.includes('LocalStorage') && l.includes('test'))).toBe(true);
            } finally {
                console.log = originalLog;
            }
        });

        test('should throw when window.localStorage is unavailable', async () => {
            uninstallLocalStorage();
            const offlineBackend = new LocalStorageBackend();
            await expect(offlineBackend.init()).rejects.toThrow(/browser environment/);
        });

        test('should be idempotent (safe to call init() multiple times)', async () => {
            await backend.init();
            // Second call must not throw
            await expect(backend.init()).resolves.toBeUndefined();
        });
    });

    // ─── generateSessionId ───────────────────────────────────────────────────

    test.describe('generateSessionId()', () => {
        test('should return a non-empty string', () => {
            expect(typeof backend.generateSessionId()).toBe('string');
            expect(backend.generateSessionId().length).toBeGreaterThan(0);
        });

        test('should return unique IDs on each call', () => {
            const ids = new Set(Array.from({ length: 20 }, () => backend.generateSessionId()));
            expect(ids.size).toBe(20);
        });
    });

    // ─── createSession ───────────────────────────────────────────────────────

    test.describe('createSession()', () => {
        test('should persist a session to localStorage', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            const retrieved = await backend.getSession(session.identity, session.sessionId);
            expect(retrieved).not.toBeNull();
            expect(retrieved?.sessionId).toBe(session.sessionId);
            expect(retrieved?.serverId).toBe(session.serverId);
        });

        test('should add the session to the identity index', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            const ids = await backend.getIdentityMcpSessions(session.identity);
            expect(ids).toContain(session.sessionId);
        });

        test('should throw if the session already exists', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            await expect(backend.createSession(session)).rejects.toThrow('already exists');
        });

        test('should respect a custom TTL and expire the session', async () => {
            const session = createMockSession({ sessionId: 'ttl-session' });
            // TTL of 0.001 seconds — effectively expires instantly
            await backend.createSession(session, 0.001);

            // Wait 5ms to ensure expiry
            await new Promise(r => setTimeout(r, 5));

            const result = await backend.getSession(session.identity, session.sessionId);
            expect(result).toBeNull(); // lazy eviction should have fired
        });

        test('should not expire when TTL is 0 (infinite)', async () => {
            const infiniteBackend = new LocalStorageBackend({ namespace: 'test', defaultTtl: 0 });
            const session = createMockSession({ sessionId: 'no-ttl' });
            await infiniteBackend.createSession(session);

            await new Promise(r => setTimeout(r, 10));

            const result = await infiniteBackend.getSession(session.identity, session.sessionId);
            expect(result).not.toBeNull();
        });

        test('should not expose internal _expiresAt field in returned data', async () => {
            const session = createMockSession({ sessionId: 'no-internal-field' });
            await backend.createSession(session, 3600);

            const result = await backend.getSession(session.identity, session.sessionId);
            expect((result as any)._expiresAt).toBeUndefined();
        });

        test('should namespace keys so two backends on the same storage do not clash', async () => {
            const backendA = new LocalStorageBackend({ namespace: 'app-a' });
            const backendB = new LocalStorageBackend({ namespace: 'app-b' });

            const session = createMockSession({ sessionId: 'same-id', identity: 'same-user' });

            await backendA.createSession(session);
            // Creating the same session in backendB must not throw (different namespace)
            await expect(backendB.createSession(session)).resolves.toBeUndefined();

            // And they must not interfere
            await backendA.removeSession(session.identity, session.sessionId);
            const stillExists = await backendB.getSession(session.identity, session.sessionId);
            expect(stillExists).not.toBeNull();
        });
    });

    // ─── getSession ──────────────────────────────────────────────────────────

    test.describe('getSession()', () => {
        test('should return null for a non-existent session', async () => {
            const result = await backend.getSession('ghost-user', 'ghost-session');
            expect(result).toBeNull();
        });

        test('should return null for a wrong identity', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            const result = await backend.getSession('wrong-identity', session.sessionId);
            expect(result).toBeNull();
        });
    });

    // ─── updateSession ───────────────────────────────────────────────────────

    test.describe('updateSession()', () => {
        test('should merge partial data into the existing session', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            const tokens = createMockTokens();
            await backend.updateSession(session.identity, session.sessionId, { tokens, active: true });

            const updated = await backend.getSession(session.identity, session.sessionId);
            expect(updated?.tokens).toEqual(tokens);
            expect(updated?.active).toBe(true);
            // Original fields must be preserved
            expect(updated?.serverId).toBe(session.serverId);
            expect(updated?.serverUrl).toBe(session.serverUrl);
        });

        test('should extend the TTL on update', async () => {
            const session = createMockSession({ sessionId: 'ttl-update' });
            // Create with a very short TTL
            await backend.createSession(session, 0.02);
            // Update immediately with a long TTL
            await backend.updateSession(session.identity, session.sessionId, { active: true }, 3600);

            // Wait past the original TTL
            await new Promise(r => setTimeout(r, 30));

            // Should still be alive thanks to the updated TTL
            const result = await backend.getSession(session.identity, session.sessionId);
            expect(result).not.toBeNull();
        });

        test('should throw if the session does not exist', async () => {
            await expect(
                backend.updateSession('nobody', 'ghost', { active: true })
            ).rejects.toThrow('not found');
        });
    });

    // ─── removeSession ───────────────────────────────────────────────────────

    test.describe('removeSession()', () => {
        test('should delete the session', async () => {
            const session = createMockSession();
            await backend.createSession(session);
            await backend.removeSession(session.identity, session.sessionId);

            const result = await backend.getSession(session.identity, session.sessionId);
            expect(result).toBeNull();
        });

        test('should remove the session from the identity index', async () => {
            const session = createMockSession();
            await backend.createSession(session);
            await backend.removeSession(session.identity, session.sessionId);

            const ids = await backend.getIdentityMcpSessions(session.identity);
            expect(ids).not.toContain(session.sessionId);
        });

        test('should be a no-op for a non-existent session (must not throw)', async () => {
            await expect(
                backend.removeSession('nobody', 'ghost')
            ).resolves.toBeUndefined();
        });
    });

    // ─── getIdentitySessionsData ─────────────────────────────────────────────

    test.describe('getIdentitySessionsData()', () => {
        test('should return all sessions for the given identity', async () => {
            const id = 'multi-user';
            await backend.createSession(createMockSession({ sessionId: 'a', identity: id }));
            await backend.createSession(createMockSession({ sessionId: 'b', identity: id }));
            await backend.createSession(createMockSession({ sessionId: 'c', identity: id }));

            const sessions = await backend.getIdentitySessionsData(id);
            expect(sessions.length).toBe(3);
            const ids = sessions.map(s => s.sessionId);
            expect(ids).toContain('a');
            expect(ids).toContain('b');
            expect(ids).toContain('c');
        });

        test('should return an empty array for an unknown identity', async () => {
            const result = await backend.getIdentitySessionsData('ghost-user');
            expect(result).toEqual([]);
        });

        test('should lazily evict expired sessions from results', async () => {
            const id = 'eviction-user';
            // Session with negligible TTL
            await backend.createSession(createMockSession({ sessionId: 'expires', identity: id }), 0.001);
            // Session that lives forever
            await backend.createSession(createMockSession({ sessionId: 'alive', identity: id }), 9999);

            await new Promise(r => setTimeout(r, 5));

            const sessions = await backend.getIdentitySessionsData(id);
            expect(sessions.length).toBe(1);
            expect(sessions[0].sessionId).toBe('alive');
        });

        test('should not include _expiresAt in any returned session', async () => {
            const id = 'no-internal';
            await backend.createSession(createMockSession({ sessionId: 's1', identity: id }), 3600);
            await backend.createSession(createMockSession({ sessionId: 's2', identity: id }), 3600);

            const sessions = await backend.getIdentitySessionsData(id);
            for (const s of sessions) {
                expect((s as any)._expiresAt).toBeUndefined();
            }
        });
    });

    // ─── getIdentityMcpSessions ──────────────────────────────────────────────

    test.describe('getIdentityMcpSessions()', () => {
        test('should return only session IDs (not full data)', async () => {
            const id = 'id-only-user';
            await backend.createSession(createMockSession({ sessionId: 'one', identity: id }));
            await backend.createSession(createMockSession({ sessionId: 'two', identity: id }));

            const ids = await backend.getIdentityMcpSessions(id);
            expect(ids).toContain('one');
            expect(ids).toContain('two');
            expect(typeof ids[0]).toBe('string');
        });

        test('should exclude expired sessions', async () => {
            const id = 'expiry-ids-user';
            await backend.createSession(createMockSession({ sessionId: 'exp', identity: id }), 0.001);
            await backend.createSession(createMockSession({ sessionId: 'ok', identity: id }), 9999);

            await new Promise(r => setTimeout(r, 5));
            const ids = await backend.getIdentityMcpSessions(id);
            expect(ids).not.toContain('exp');
            expect(ids).toContain('ok');
        });
    });

    // ─── getAllSessionIds ─────────────────────────────────────────────────────

    test.describe('getAllSessionIds()', () => {
        test('should aggregate session IDs across multiple identities', async () => {
            await backend.createSession(createMockSession({ sessionId: 's1', identity: 'user-1' }));
            await backend.createSession(createMockSession({ sessionId: 's2', identity: 'user-1' }));
            await backend.createSession(createMockSession({ sessionId: 's3', identity: 'user-2' }));

            const ids = await backend.getAllSessionIds();
            expect(ids).toContain('s1');
            expect(ids).toContain('s2');
            expect(ids).toContain('s3');
        });

        test('should return an empty array when no sessions exist', async () => {
            const ids = await backend.getAllSessionIds();
            expect(ids).toEqual([]);
        });
    });

    // ─── clearAll ────────────────────────────────────────────────────────────

    test.describe('clearAll()', () => {
        test('should remove all sessions under the namespace', async () => {
            await backend.createSession(createMockSession({ sessionId: 'x', identity: 'u1' }));
            await backend.createSession(createMockSession({ sessionId: 'y', identity: 'u2' }));

            await backend.clearAll();

            expect(await backend.getAllSessionIds()).toEqual([]);
            expect(await backend.getSession('u1', 'x')).toBeNull();
            expect(await backend.getSession('u2', 'y')).toBeNull();
        });

        test('should not remove keys outside its namespace', async () => {
            const otherBackend = new LocalStorageBackend({ namespace: 'other' });
            const sharedSession = createMockSession({ sessionId: 'shared', identity: 'shared-user' });

            await otherBackend.createSession(sharedSession);
            await backend.createSession(createMockSession({ sessionId: 'mine', identity: 'me' }));

            await backend.clearAll();

            // The "other" namespace session must survive
            const surviving = await otherBackend.getSession(sharedSession.identity, sharedSession.sessionId);
            expect(surviving).not.toBeNull();
        });
    });

    // ─── cleanupExpiredSessions ──────────────────────────────────────────────

    test.describe('cleanupExpiredSessions()', () => {
        test('should evict sessions whose TTL has elapsed', async () => {
            const id = 'cleanup-user';
            await backend.createSession(createMockSession({ sessionId: 'gone', identity: id }), 0.001);
            await backend.createSession(createMockSession({ sessionId: 'stays', identity: id }), 9999);

            await new Promise(r => setTimeout(r, 5));
            await backend.cleanupExpiredSessions();

            const ids = await backend.getIdentityMcpSessions(id);
            expect(ids).not.toContain('gone');
            expect(ids).toContain('stays');
        });

        test('should be a no-op when there are no expired sessions', async () => {
            await backend.createSession(createMockSession({ sessionId: 'fine', identity: 'fine-user' }), 9999);
            await expect(backend.cleanupExpiredSessions()).resolves.toBeUndefined();
            const result = await backend.getSession('fine-user', 'fine');
            expect(result).not.toBeNull();
        });
    });

    // ─── disconnect ──────────────────────────────────────────────────────────

    test.describe('disconnect()', () => {
        test('should resolve without error (no-op for localStorage)', async () => {
            await expect(backend.disconnect()).resolves.toBeUndefined();
        });
    });

    // ─── OAuth data preservation ─────────────────────────────────────────────

    test.describe('OAuth data round-trip', () => {
        test('should persist and retrieve OAuth tokens via updateSession', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            const tokens = createMockTokens({ access_token: 'tok_secret' });
            await backend.updateSession(session.identity, session.sessionId, { tokens });

            const result = await backend.getSession(session.identity, session.sessionId);
            expect(result?.tokens?.access_token).toBe('tok_secret');
            expect(result?.tokens?.token_type).toBe('Bearer');
        });

        test('should persist and retrieve clientInformation via updateSession', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            const clientInfo = createMockClientInfo();
            await backend.updateSession(session.identity, session.sessionId, {
                clientInformation: clientInfo as any,
            });

            const result = await backend.getSession(session.identity, session.sessionId);
            expect((result?.clientInformation as any)?.client_id).toBe(clientInfo.client_id);
        });

        test('should persist and retrieve PKCE code verifier via updateSession', async () => {
            const session = createMockSession();
            await backend.createSession(session);

            await backend.updateSession(session.identity, session.sessionId, {
                codeVerifier: 'pkce-verifier-abc123',
            });

            const result = await backend.getSession(session.identity, session.sessionId);
            expect(result?.codeVerifier).toBe('pkce-verifier-abc123');
        });
    });
});
