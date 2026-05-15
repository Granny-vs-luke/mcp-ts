/**
 * Tests for MemoryStorageBackend
 */
import { test, expect } from '@playwright/test';
import { MemoryStorageBackend } from '../../src/server/storage/memory-backend';
import { createMockSession, createMockTokens } from '../test-utils';

test.describe('MemoryStorageBackend', () => {
    let storage: MemoryStorageBackend;

    test.beforeEach(() => {
        storage = new MemoryStorageBackend();
    });

    test.describe('createSession', () => {
        test('should store session data in memory', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            const retrieved = await storage.getSession(session.userId, session.sessionId);
            expect(retrieved).toBeDefined();
            expect(retrieved?.serverId).toBe(session.serverId);
        });

        test('should throw if session already exists', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            await expect(storage.createSession(session)).rejects.toThrow('already exists');
        });
    });

    test.describe('updateSession', () => {
        test('should update existing session', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            await storage.updateSession(session.userId, session.sessionId, {
                active: true,
                tokens: createMockTokens()
            });

            const retrieved = await storage.getSession(session.userId, session.sessionId);
            expect(retrieved?.active).toBe(true);
            expect(retrieved?.tokens).toBeDefined();
            expect(retrieved?.serverId).toBe(session.serverId);
        });

        test('should throw if session does not exist', async () => {
            await expect(
                storage.updateSession('unknown', 'unknown', { active: true })
            ).rejects.toThrow('not found');
        });
    });

    test.describe('listSessions', () => {
        test('should return all sessions for an userId', async () => {
            const userId = 'test-user';
            const session1 = createMockSession({ sessionId: 'session-1', userId });
            const session2 = createMockSession({ sessionId: 'session-2', userId });

            await storage.createSession(session1);
            await storage.createSession(session2);

            const sessions = await storage.listSessions(userId);
            expect(sessions.length).toBe(2);
        });
    });

    test.describe('deleteSession', () => {
        test('should delete session from memory', async () => {
            const session = createMockSession();
            await storage.createSession(session);

            await storage.deleteSession(session.userId, session.sessionId);

            const result = await storage.getSession(session.userId, session.sessionId);
            expect(result).toBeNull();
        });
    });
});
