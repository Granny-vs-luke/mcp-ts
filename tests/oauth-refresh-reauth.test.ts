import { test, expect } from '@playwright/test';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';
import { UnauthorizedError } from '../src/shared/errors';

test.describe('MCPClient refresh-token reauthorization', () => {
  const originalInitialize = (MCPClient.prototype as any).initialize;
  const originalTryConnect = (MCPClient.prototype as any).tryConnect;

  test.afterEach(() => {
    (MCPClient.prototype as any).initialize = originalInitialize;
    (MCPClient.prototype as any).tryConnect = originalTryConnect;
    _setStorageInstanceForTesting(null);
  });

  test('does not refresh expired tokens outside SDK transport auth', async () => {
    _setStorageInstanceForTesting(new MemoryStorageBackend());

    let saveTokensCalled = false;
    let invalidateCredentialsCalled = false;

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = {
        tokens: async () => ({
          access_token: 'expired-access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
        }),
        isTokenExpired: () => true,
        saveTokens: async () => {
          saveTokensCalled = true;
        },
        invalidateCredentials: async () => {
          invalidateCredentialsCalled = true;
        },
      };
    };

    const client = new MCPClient({
      userId: 'user-1',
      sessionId: 'session-1',
      serverId: 'server-1',
      serverName: 'Server One',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable-http',
    });

    await expect(client.getValidTokens()).resolves.toBe(false);
    await expect(client.refreshToken()).resolves.toBe(false);
    expect(saveTokensCalled).toBe(false);
    expect(invalidateCredentialsCalled).toBe(false);
  });

  test('emits auth_required when SDK transport requests authorization', async () => {
    _setStorageInstanceForTesting(new MemoryStorageBackend());

    const events: any[] = [];

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = {
        authUrl: 'https://auth.example.com/authorize?state=session-2',
      };
    };

    (MCPClient.prototype as any).tryConnect = async () => {
      throw new Error('unauthorized');
    };

    const client = new MCPClient({
      userId: 'user-2',
      sessionId: 'session-2',
      serverId: 'server-2',
      serverName: 'Server Two',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable-http',
    });
    client.onConnectionEvent((event) => events.push(event));

    await expect(client.connect()).rejects.toBeInstanceOf(UnauthorizedError);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'auth_required',
      sessionId: 'session-2',
      serverId: 'server-2',
      authUrl: 'https://auth.example.com/authorize?state=session-2',
    }));
  });
});
