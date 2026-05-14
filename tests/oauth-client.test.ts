import { test, expect } from '@playwright/test';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { storage, _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';

test.describe('MCPClient.getMcpServerConfig', () => {
    const userId = 'test-user';

    const originalInitialize = (MCPClient.prototype as any).initialize;
    const originalGetValidTokens = (MCPClient.prototype as any).getValidTokens;

    test.afterEach(() => {
        // Restore methods
        _setStorageInstanceForTesting(null); // Reset storage
        (MCPClient.prototype as any).initialize = originalInitialize;
        (MCPClient.prototype as any).getValidTokens = originalGetValidTokens;
    });

    test('should process multiple sessions in parallel and return the correct config', async () => {
        // Spy counts
        let initCallCount = 0;
        let getTokensCallCount = 0;

        // Mock Initialize
        (MCPClient.prototype as any).initialize = async function () {
            initCallCount++;
            // Manually inject a mock provider if needed, or do nothing
        };

        // Mock GetValidTokens
        (MCPClient.prototype as any).getValidTokens = async function () {
            getTokensCallCount++;
            return true;
        };

        const session1 = {
            sessionId: 's1',
            active: true,
            serverId: 'server1',
            serverName: 'Server One',
            serverUrl: 'http://server1',
            transportType: 'sse' as const,
            callbackUrl: 'http://callback1',
        };
        const session2 = {
            sessionId: 's2',
            active: true,
            serverId: 'server2',
            serverName: 'Server Two',
            serverUrl: 'http://server2',
            transportType: 'streamable-http' as const,
            callbackUrl: 'http://callback2',
        };

        // Mock storage
        const mockStorage = new MemoryStorageBackend();
        mockStorage.getUserSession = async (id: string) => {
            if (id === userId) return [session1, session2] as any;
            return [];
        };
        _setStorageInstanceForTesting(mockStorage);

        const config = await MCPClient.getMcpServerConfig(userId);

        expect(initCallCount).toBe(2);
        expect(getTokensCallCount).toBe(2);

        expect(config).toEqual({
            'server_one': expect.objectContaining({
                transport: 'sse',
                url: 'http://server1',
            }),
            'server_two': expect.objectContaining({
                transport: 'streamable-http',
                url: 'http://server2',
            }),
        });
    });

    test('should remove inactive sessions', async () => {
        const session1 = {
            sessionId: 's1',
            active: false,
            serverId: 'server1',
            serverUrl: 'http://server1',
            callbackUrl: 'http://callback1',
        };

        let removeSessionCalledWith: any[] = [];

        // Mock storage
        const mockStorage = new MemoryStorageBackend();
        mockStorage.getUserSession = async (id: string) => {
            return [session1] as any;
        };
        mockStorage.removeSession = async (id: string, sId: string) => {
            removeSessionCalledWith = [id, sId];
        };
        _setStorageInstanceForTesting(mockStorage);

        const config = await MCPClient.getMcpServerConfig(userId);

        expect(removeSessionCalledWith).toEqual([userId, 's1']);
        expect(config).toEqual({});
    });
});

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
