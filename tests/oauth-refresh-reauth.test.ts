import { test, expect } from '@playwright/test';
import http from 'node:http';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';
import { UnauthorizedError } from '../src/shared/errors';

test.describe('MCPClient refresh-token reauthorization', () => {
  const originalInitialize = (MCPClient.prototype as any).initialize;
  const originalGetValidTokens = (MCPClient.prototype as any).getValidTokens;
  const originalTryConnect = (MCPClient.prototype as any).tryConnect;

  test.afterEach(() => {
    (MCPClient.prototype as any).initialize = originalInitialize;
    (MCPClient.prototype as any).getValidTokens = originalGetValidTokens;
    (MCPClient.prototype as any).tryConnect = originalTryConnect;
    _setStorageInstanceForTesting(null);
  });

  test('emits auth_required after invalid refresh token credentials are cleared', async () => {
    _setStorageInstanceForTesting(new MemoryStorageBackend());
    const authServer = await startInvalidGrantAuthServer();

    let invalidatedScope: string | null = null;
    const events: any[] = [];

    (MCPClient.prototype as any).initialize = async function () {
      (this as any).client = {} as any;
      (this as any).oauthProvider = {
        authUrl: 'https://auth.example.com/authorize?state=session-1',
        tokens: async () => ({
          access_token: 'expired-access-token',
          refresh_token: 'invalid-refresh-token',
          token_type: 'Bearer',
        }),
        clientInformation: async () => ({
          client_id: 'client-1',
        }),
        isTokenExpired: () => true,
        saveTokens: async () => {
          throw new Error('refresh should not succeed');
        },
        invalidateCredentials: async (scope: string) => {
          invalidatedScope = scope;
        },
      };
    };

    (MCPClient.prototype as any).tryConnect = async () => {
      throw new Error('unauthorized');
    };

    const client = new MCPClient({
      userId: 'user-1',
      sessionId: 'session-1',
      serverId: 'server-1',
      serverName: 'Server One',
      serverUrl: authServer.serverUrl,
      callbackUrl: 'https://app.example.com/callback',
      transportType: 'streamable-http',
    });
    client.onConnectionEvent((event) => events.push(event));

    try {
      await expect(client.connect()).rejects.toBeInstanceOf(UnauthorizedError);

      expect(invalidatedScope).toBe('tokens');
      expect(events).toContainEqual(expect.objectContaining({
        type: 'auth_required',
        sessionId: 'session-1',
        serverId: 'server-1',
        authUrl: 'https://auth.example.com/authorize?state=session-1',
      }));
    } finally {
      await authServer.close();
    }
  });
});

async function startInvalidGrantAuthServer(): Promise<{
  serverUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const path = req.url?.split('?')[0] || '/';

    if (path === '/.well-known/oauth-protected-resource/mcp') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      }));
      return;
    }

    if (path === '/.well-known/oauth-authorization-server') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      }));
      return;
    }

    if (path === '/token') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as any).port;
  return {
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
