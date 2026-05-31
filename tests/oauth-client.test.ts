import { test, expect } from '@playwright/test';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';

test.describe('MCPClient static Authorization headers', () => {
    test.afterEach(() => {
        _setStorageInstanceForTesting(null);
    });

    test('passes Authorization through requestInit and disables OAuth provider on the transport', async () => {
        _setStorageInstanceForTesting(new MemoryStorageBackend());

        const client = new MCPClient({
            userId: 'test-user',
            sessionId: 'static-auth-session',
            serverId: 'static-auth-server',
            serverName: 'Static Auth Server',
            serverUrl: 'https://example.com/mcp',
            callbackUrl: 'https://app.local/auth/callback',
            transportType: 'streamable-http',
            headers: {
                Authorization: 'Bearer static-token',
            },
        });

        await (client as any).initialize();
        const transport = (client as any).getTransport('streamable-http');

        expect((transport as any)._requestInit?.headers).toEqual({
            Authorization: 'Bearer static-token',
        });
        expect((transport as any)._authProvider).toBeUndefined();
    });
});
