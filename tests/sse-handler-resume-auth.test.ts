import { test, expect } from '@playwright/test';
import { SSEConnectionManager } from '../src/server/handlers/sse-handler';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';

test.describe('SSEConnectionManager connect duplicate handling', () => {
  test.afterEach(() => {
    _setStorageInstanceForTesting(null);
  });

  test('resumes pending-auth duplicate session instead of throwing duplicate error', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);

    await storage.createSession({
      sessionId: 'existing-session',
      identity: 'user-1',
      serverId: 'srv-1',
      serverName: 'Server One',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.local/oauth/callback',
      transportType: 'streamable_http',
      createdAt: Date.now(),
      active: false,
    });

    const manager = new SSEConnectionManager(
      { identity: 'user-1' },
      () => { }
    );

    let resumedSessionId: string | null = null;
    (manager as any).restoreSession = async ({ sessionId }: { sessionId: string }) => {
      resumedSessionId = sessionId;
      return { success: true, toolCount: 0 };
    };

    const response = await manager.handleRequest({
      id: '1',
      method: 'connect',
      params: {
        serverId: 'srv-1',
        serverName: 'Server One',
        serverUrl: 'https://example.com/mcp',
        callbackUrl: 'https://app.local/oauth/callback',
      },
    } as any);

    expect((response as any).error).toBeUndefined();
    expect((response as any).result).toEqual({
      sessionId: 'existing-session',
      success: true,
    });
    expect(resumedSessionId).toBe('existing-session');

    manager.dispose();
  });

  test('still throws duplicate error for already active sessions', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);

    await storage.createSession({
      sessionId: 'existing-active',
      identity: 'user-2',
      serverId: 'srv-2',
      serverName: 'Server Two',
      serverUrl: 'https://example.com/mcp-active',
      callbackUrl: 'https://app.local/oauth/callback',
      transportType: 'streamable_http',
      createdAt: Date.now(),
      active: true,
    });

    const manager = new SSEConnectionManager(
      { identity: 'user-2' },
      () => { }
    );

    const response = await manager.handleRequest({
      id: '2',
      method: 'connect',
      params: {
        serverId: 'srv-2',
        serverName: 'Server Two',
        serverUrl: 'https://example.com/mcp-active',
        callbackUrl: 'https://app.local/oauth/callback',
      },
    } as any);

    expect((response as any).result).toBeUndefined();
    expect((response as any).error?.message).toContain('Connection already exists');

    manager.dispose();
  });
});

