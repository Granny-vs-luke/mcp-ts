/**
 * Tests for RedisStorageBackend
 */
import { test, expect } from '@playwright/test';
import Redis from 'ioredis-mock';
import { RedisStorageBackend } from '../../src/server/storage/redis-backend';
import { setRedisInstance } from '../../src/server/storage/redis';
import { createMockSession, createMockTokens } from '../test-utils';

test.describe('RedisStorageBackend', () => {
    let redis: any;
    let storage: RedisStorageBackend;

    test.beforeEach(() => {
        redis = new Redis();
        setRedisInstance(redis as any);
        storage = new RedisStorageBackend(redis as any);
    });

    test.afterEach(async () => {
        await redis.flushall();
        redis.disconnect();
    });

    test.describe('generateSessionId', () => {
        test('should generate unique session IDs', () => {
            const id1 = storage.generateSessionId();
            const id2 = storage.generateSessionId();

            expect(id1).toBeDefined();
            expect(id2).toBeDefined();
            expect(id1).not.toBe(id2);
            expect(id1.length).toBeGreaterThan(10);
        });
    });

    test.describe('createSession', () => {
        test('should store session data in Redis', async () => {
            const session = createMockSession();

            await storage.createSession(session);

            const storedData = await redis.get(`mcp:session:${session.userId}:${session.sessionId}`);
            expect(storedData).toBeDefined();

            const parsed = JSON.parse(storedData!);
            expect(parsed.serverId).toBe(session.serverId);
            expect(parsed.serverUrl).toBe(session.serverUrl);
        });

        test('should set TTL on session', async () => {
            const session = createMockSession();

            await storage.createSession(session);

            const ttl = await redis.ttl(`mcp:session:${session.userId}:${session.sessionId}`);
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(43200); // 12 hours
        });

        test('should throw if session already exists', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            await expect(storage.createSession(session)).rejects.toThrow('already exists');
        });
    });

    test.describe('updateSession', () => {
        // Note: This test is skipped because ioredis-mock doesn't support cjson in Lua scripts
        // The Lua script works correctly in production Redis
        test.skip('should update existing session atomically', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            await storage.updateSession(session.userId, session.sessionId, {
                active: true,
                tokens: createMockTokens()
            });

            const retrieved = await storage.getSession(session.userId, session.sessionId);
            expect(retrieved?.active).toBe(true);
            expect(retrieved?.tokens).toBeDefined();
            expect(retrieved?.serverId).toBe(session.serverId); // Original data preserved
        });

        test('should throw if session does not exist', async () => {
            await expect(
                storage.updateSession('unknown', 'unknown', { active: true })
            ).rejects.toThrow('not found');
        });
    });

    test.describe('getSession', () => {
        test('should retrieve stored session', async () => {
            const session = createMockSession();

            await storage.createSession(session);

            const retrieved = await storage.getSession(session.userId, session.sessionId);

            expect(retrieved).toBeDefined();
            expect(retrieved?.serverId).toBe(session.serverId);
            expect(retrieved?.serverUrl).toBe(session.serverUrl);
        });

        test('should return null for non-existent session', async () => {
            const result = await storage.getSession('unknown-user', 'unknown-session');
            expect(result).toBeNull();
        });
    });

    test.describe('removeSession', () => {
        test('should delete session from Redis', async () => {
            const session = createMockSession();

            await storage.createSession(session);

            await storage.removeSession(session.userId, session.sessionId);

            const result = await storage.getSession(session.userId, session.sessionId);
            expect(result).toBeNull();
        });
    });

    test.describe('getUserSession', () => {
        test('should return all sessions for a userId', async () => {
            const userId = 'test-user';
            const session1 = createMockSession({ sessionId: 'session-1', userId });
            const session2 = createMockSession({ sessionId: 'session-2', userId, serverName: 'Server 2' });

            await storage.createSession(session1);
            await storage.createSession(session2);

            const sessions = await storage.getUserSession(userId);

            expect(sessions.length).toBe(2);
            expect(sessions.map(s => s.sessionId)).toContain('session-1');
            expect(sessions.map(s => s.sessionId)).toContain('session-2');
        });

        test('should return empty array for userId with no sessions', async () => {
            const sessions = await storage.getUserSession('unknown-user');
            expect(sessions).toEqual([]);
        });

        test('should prune stale session ids from the userId index', async () => {
            const session = createMockSession({ sessionId: 'stale-session' });
            await storage.createSession(session);

            await redis.del(`mcp:session:${session.userId}:${session.sessionId}`);

            const sessions = await storage.getUserSession(session.userId);
            const indexedSessionIds = await redis.smembers(`mcp:userId:${session.userId}:sessions`);

            expect(sessions).toEqual([]);
            expect(indexedSessionIds).toEqual([]);
        });
    });

    test.describe('getAllSessionIds', () => {
        test('should return plain session ids without userId prefixes', async () => {
            const session = createMockSession({ sessionId: 'session-admin-view' });
            await storage.createSession(session);

            const sessionIds = await storage.getAllSessionIds();

            expect(sessionIds).toContain('session-admin-view');
            expect(sessionIds).not.toContain(`${session.userId}:${session.sessionId}`);
        });
    });

    test.describe('clearAll', () => {
        test('should delete both session keys and userId indexes', async () => {
            const session = createMockSession({ sessionId: 'clear-all-session' });
            await storage.createSession(session);

            await storage.clearAll();

            const sessionIds = await storage.getUserSessionIds(session.userId);
            const indexedSessionIds = await redis.smembers(`mcp:userId:${session.userId}:sessions`);

            expect(sessionIds).toEqual([]);
            expect(indexedSessionIds).toEqual([]);
        });
    });

    test.describe('cleanupExpiredSessions', () => {
        test('should remove stale userId indexes for missing session keys', async () => {
            const session = createMockSession({ sessionId: 'expired-session' });
            await storage.createSession(session);

            await redis.del(`mcp:session:${session.userId}:${session.sessionId}`);

            await storage.cleanupExpiredSessions();

            const indexedSessionIds = await redis.smembers(`mcp:userId:${session.userId}:sessions`);
            expect(indexedSessionIds).toEqual([]);
        });
    });
});
