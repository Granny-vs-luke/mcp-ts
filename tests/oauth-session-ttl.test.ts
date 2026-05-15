import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { _setStorageInstanceForTesting, sessions } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';
import { SESSION_TTL_SECONDS, STATE_EXPIRATION_MS } from '../src/shared/constants';
import type { Session } from '../src/server/storage/types';
import { UnauthorizedError } from '../src/shared/errors';

class TrackingMemoryStorage extends MemoryStorageBackend {
  public createCalls: Array<{ session: Session; ttl?: number }> = [];
  public updateCalls: Array<{ userId: string; sessionId: string; data: Partial<Session>; ttl?: number }> = [];

  async create(session: Session, ttl?: number): Promise<void> {
    this.createCalls.push({ session, ttl });
    return super.create(session, ttl);
  }

  async update(userId: string, sessionId: string, data: Partial<Session>, ttl?: number): Promise<void> {
    this.updateCalls.push({ userId, sessionId, data, ttl });
    return super.update(userId, sessionId, data, ttl);
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

  test('non-oauth server: each successful connect refreshes the active session TTL', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = { authUrl: '' };

      const userId = (this as any).userId;
      const sessionId = (this as any).sessionId;
      const existing = await sessions.get(userId, sessionId);

      if (!existing) {
        await sessions.create({
          sessionId,
          userId,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable-http',
          createdAt: Date.now(),
          active: false,
        }, Math.floor(STATE_EXPIRATION_MS / 1000));
      }
    };
    (MCPClient.prototype as any).getValidTokens = async () => true;
    (MCPClient.prototype as any).tryConnect = async () => ({ transportType: 'streamable-http' });

    const client = new MCPClient({
      userId: 'user-1',
      sessionId: 's-1',
      serverId: 'srv-1',
      serverName: 'Server One',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable-http',
    });

    await client.connect();
    await client.connect();

    const shortTtlSeconds = Math.floor(STATE_EXPIRATION_MS / 1000);
    const shortCreates = mockStorage.createCalls.filter(c => c.ttl === shortTtlSeconds);
    const longUpdates = mockStorage.updateCalls.filter(c => c.ttl === SESSION_TTL_SECONDS);

    expect(shortCreates).toHaveLength(1);
    expect(longUpdates).toHaveLength(2);

    const session = await sessions.get('user-1', 's-1');
    expect(session?.active).toBe(true);
  });

  test('oauth server authenticating state uses 10 minute TTL', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = { authUrl: 'https://auth.example.com' };

      const userId = (this as any).userId;
      const sessionId = (this as any).sessionId;
      const existing = await sessions.get(userId, sessionId);

      if (!existing) {
        await sessions.create({
          sessionId,
          userId,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable-http',
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
      userId: 'user-2',
      sessionId: 's-2',
      serverId: 'srv-2',
      serverName: 'Server Two',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable-http',
    });

    await expect(client.connect()).rejects.toBeInstanceOf(UnauthorizedError);

    const shortTtlSeconds = Math.floor(STATE_EXPIRATION_MS / 1000);
    const shortUpdates = mockStorage.updateCalls.filter(c => c.ttl === shortTtlSeconds);
    expect(shortUpdates.length).toBeGreaterThan(0);

    const session = await sessions.get('user-2', 's-2');
    expect(session?.active).toBe(false);
  });

  test('oauth finishAuth updates session TTL to 12 hours', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).oauthProvider = { authUrl: 'https://auth.example.com' };

      const userId = (this as any).userId;
      const sessionId = (this as any).sessionId;
      const existing = await sessions.get(userId, sessionId);

      if (!existing) {
        await sessions.create({
          sessionId,
          userId,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable-http',
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
      userId: 'user-3',
      sessionId: 's-3',
      serverId: 'srv-3',
      serverName: 'Server Three',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable-http',
    });

    await client.finishAuth('auth-code');

    const longUpdates = mockStorage.updateCalls.filter(c => c.ttl === SESSION_TTL_SECONDS);
    expect(longUpdates.length).toBeGreaterThan(0);

    const session = await sessions.get('user-3', 's-3');
    expect(session?.active).toBe(true);
  });

  test('oauth finishAuth emits AUTHENTICATED only once across transport fallback', async () => {
    const mockStorage = new TrackingMemoryStorage();
    _setStorageInstanceForTesting(mockStorage);

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).oauthProvider = { authUrl: 'https://auth.example.com' };

      const userId = (this as any).userId;
      const sessionId = (this as any).sessionId;
      const existing = await sessions.get(userId, sessionId);

      if (!existing) {
        await sessions.create({
          sessionId,
          userId,
          serverId: (this as any).serverId,
          serverName: (this as any).serverName,
          serverUrl: (this as any).serverUrl,
          callbackUrl: (this as any).callbackUrl,
          transportType: (this as any).transportType || 'streamable-http',
          createdAt: Date.now(),
          active: false,
        }, Math.floor(STATE_EXPIRATION_MS / 1000));
      }
    };

    const connectAttempts: string[] = [];
    const finishAuthAttempts: string[] = [];

    (MCPClient.prototype as any).getTransport = function (type: string) {
      return {
        finishAuth: async () => {
          finishAuthAttempts.push(type);
        },
      };
    };

    (Client.prototype as any).connect = async function (transport: any) {
      const attemptType = connectAttempts.length === 0 ? 'streamable-http' : 'sse';
      connectAttempts.push(attemptType);

      if (attemptType === 'streamable-http') {
        throw new Error('Method Not Allowed');
      }

      return transport;
    };

    const client = new MCPClient({
      userId: 'user-4',
      sessionId: 's-4',
      serverId: 'srv-4',
      serverName: 'Server Four',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://app.example.com/callback',
    });

    const states: string[] = [];
    client.onConnectionEvent((event) => {
      if (event.type === 'state_changed') {
        states.push(event.state);
      }
    });

    await client.finishAuth('auth-code');

    expect(finishAuthAttempts).toEqual(['streamable-http']);
    expect(connectAttempts).toEqual(['streamable-http', 'sse']);
    expect(states.filter((state) => state === 'AUTHENTICATED')).toHaveLength(1);
  });
});
