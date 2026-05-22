import { test, expect } from '@playwright/test';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { sessions, _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';

test.describe('MCPClient.getMcpServerConfig', () => {
    const userId = 'test-user';

    test.afterEach(() => {
        _setStorageInstanceForTesting(null); // Reset storage
    });

    test('should process multiple sessions in parallel and return the correct config', async () => {
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
        mockStorage.list = async (id: string) => {
            if (id === userId) return [session1, session2] as any;
            return [];
        };
        _setStorageInstanceForTesting(mockStorage);

        const config = await MCPClient.getMcpServerConfig(userId);

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

        let deleteCalledWith: any[] = [];

        // Mock storage
        const mockStorage = new MemoryStorageBackend();
        mockStorage.list = async (id: string) => {
            return [session1] as any;
        };
        mockStorage.delete = async (id: string, sId: string) => {
            deleteCalledWith = [id, sId];
        };
        _setStorageInstanceForTesting(mockStorage);

        const config = await MCPClient.getMcpServerConfig(userId);

        expect(deleteCalledWith).toEqual([userId, 's1']);
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
