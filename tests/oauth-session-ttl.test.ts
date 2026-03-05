import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { _setStorageInstanceForTesting, storage } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';
import { SESSION_TTL_SECONDS, STATE_EXPIRATION_MS } from '../src/shared/constants';
import type { SessionData } from '../src/server/storage/types';
import { UnauthorizedError } from '../src/shared/errors';

class TrackingMemoryStorage extends MemoryStorageBackend {
  public createCalls: Array<{ session: SessionData; ttl?: number }> = [];
  public updateCalls: Array<{ identity: string; sessionId: string; data: Partial<SessionData>; ttl?: number }> = [];

  async createSession(session: SessionData, ttl?: number): Promise<void> {
    this.createCalls.push({ session, ttl });
    return super.createSession(session, ttl);
  }

  async updateSession(identity: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
    this.updateCalls.push({ identity, sessionId, data, ttl });
    return super.updateSession(identity, sessionId, data, ttl);
  }
}

test.describe('MCPClient session TTL lifecycle', () => {
  const originalInitialize = (MCPClient.prototype as any).initialize;
  const originalGetValidTokens = (MCPClient.prototype as any).getValidTokens;
  const originalTryConnect = (MCPClient.prototype as any).tryConnect;
  const originalGetTransport = (MCPClient.prototype as any).getTransport;
  const originalClientConnect = (Client.prototype as any).connect;

  test.afterEach(() => {
    (MCPClient.prototype as any).initialize = originalInitialize;
    (MCPClient.prototype as any).getValidTokens = originalGetValidTokens;
    (MCPClient.prototype as any).tryConnect = originalTryConnect;
    (MCPClient.prototype as any).getTransport = originalGetTransport;
    (Client.prototype as any).connect = originalClientConnect;
    _setStorageInstanceForTesting(null);
  });

  test('non-oauth server: initial short TTL is promoted to 12h only once', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = { authUrl: '' };

      const identity = (this as any).identity;
      const sessionId = (this as any).sessionId;
      const existing = await storage.getSession(identity, sessionId);

      if (!existing) {
        await storage.createSession({
          sessionId,
          identity,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable_http',
          createdAt: Date.now(),
          active: false,
        }, Math.floor(STATE_EXPIRATION_MS / 1000));
      }
    };
    (MCPClient.prototype as any).getValidTokens = async () => true;
    (MCPClient.prototype as any).tryConnect = async () => ({ transportType: 'streamable_http' });

    const client = new MCPClient({
      identity: 'user-1',
      sessionId: 's-1',
      serverId: 'srv-1',
      serverName: 'Server One',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable_http',
    });

    await client.connect();
    await client.connect();

    const shortTtlSeconds = Math.floor(STATE_EXPIRATION_MS / 1000);
    const shortCreates = mockStorage.createCalls.filter(c => c.ttl === shortTtlSeconds);
    const longUpdates = mockStorage.updateCalls.filter(c => c.ttl === SESSION_TTL_SECONDS);

    expect(shortCreates).toHaveLength(1);
    expect(longUpdates).toHaveLength(1);

    const session = await storage.getSession('user-1', 's-1');
    expect(session?.active).toBe(true);
  });

  test('oauth server authenticating state uses 10 minute TTL', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = { authUrl: 'https://auth.example.com' };

      const identity = (this as any).identity;
      const sessionId = (this as any).sessionId;
      const existing = await storage.getSession(identity, sessionId);

      if (!existing) {
        await storage.createSession({
          sessionId,
          identity,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable_http',
          createdAt: Date.now(),
          active: false,
        }, Math.floor(STATE_EXPIRATION_MS / 1000));
      }
    };
    (MCPClient.prototype as any).getValidTokens = async () => true;
    (MCPClient.prototype as any).tryConnect = async () => {
      throw new Error('unauthorized');
    };

    const client = new MCPClient({
      identity: 'user-2',
      sessionId: 's-2',
      serverId: 'srv-2',
      serverName: 'Server Two',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable_http',
    });

    await expect(client.connect()).rejects.toBeInstanceOf(UnauthorizedError);

    const shortTtlSeconds = Math.floor(STATE_EXPIRATION_MS / 1000);
    const shortUpdates = mockStorage.updateCalls.filter(c => c.ttl === shortTtlSeconds);
    expect(shortUpdates.length).toBeGreaterThan(0);

    const session = await storage.getSession('user-2', 's-2');
    expect(session?.active).toBe(false);
  });

  test('oauth finishAuth updates session TTL to 12 hours', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).oauthProvider = { authUrl: 'https://auth.example.com' };

      const identity = (this as any).identity;
      const sessionId = (this as any).sessionId;
      const existing = await storage.getSession(identity, sessionId);

      if (!existing) {
        await storage.createSession({
          sessionId,
          identity,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable_http',
          createdAt: Date.now(),
          active: false,
        }, Math.floor(STATE_EXPIRATION_MS / 1000));
      }
    };

    (MCPClient.prototype as any).getTransport = function () {
      return {
        finishAuth: async () => { },
      };
    };

    (Client.prototype as any).connect = async () => { };

    const client = new MCPClient({
      identity: 'user-3',
      sessionId: 's-3',
      serverId: 'srv-3',
      serverName: 'Server Three',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable_http',
    });

    await client.finishAuth('auth-code');

    const longUpdates = mockStorage.updateCalls.filter(c => c.ttl === SESSION_TTL_SECONDS);
    expect(longUpdates.length).toBeGreaterThan(0);

    const session = await storage.getSession('user-3', 's-3');
    expect(session?.active).toBe(true);
  });
});
