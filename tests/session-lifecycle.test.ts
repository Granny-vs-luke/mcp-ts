import { test, expect } from '@playwright/test';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';
import { UnauthorizedError as SDKUnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { STATE_EXPIRATION_MS, SESSION_TTL_SECONDS } from '../src/shared/constants';

test.describe('Session Lifecycle Management', () => {
    const identity = 'test-user';
    const sessionId = 'test-session';
    const serverId = 'test-server';
    const serverUrl = 'http://localhost:8080';
    const callbackUrl = 'http://localhost:3000/callback';

    let mockStorage: MemoryStorageBackend;

    test.beforeEach(() => {
        mockStorage = new MemoryStorageBackend();
        _setStorageInstanceForTesting(mockStorage);
    });

    test.afterEach(() => {
        _setStorageInstanceForTesting(null);
    });

    test('Scenario 1: Successful Connection Promotion (active: true, long TTL)', async () => {
        const client = new MCPClient({
            identity,
            sessionId,
            serverId,
            serverUrl,
            callbackUrl,
        });

        // Mock internal methods to simulate success
        (client as any).initialize = async () => { 
            (client as any).oauthProvider = { 
                tokens: async () => ({ access_token: 'valid' }),
                isTokenExpired: () => false
            };
            (client as any).client = { connect: async () => {} };
        };
        (client as any).getValidTokens = async () => true;
        (client as any).tryConnect = async () => ({ transportType: 'sse' });

        // First creation with active: false occurs in initialize (mocked above, so let's verify saveSession call)
        // Actually, let's let the real connect run but mock the terminal operations
        
        let savedWithTtl = 0;
        let savedWithActive = false;
        
        const originalSaveSession = (client as any).saveSession.bind(client);
        (client as any).saveSession = async (ttl: number, active: boolean) => {
            savedWithTtl = ttl;
            savedWithActive = active;
            return originalSaveSession(ttl, active);
        };

        await client.connect();

        expect(savedWithActive).toBe(true);
        expect(savedWithTtl).toBe(SESSION_TTL_SECONDS);
        
        const session = await mockStorage.getSession(identity, sessionId);
        expect(session?.active).toBe(true);
    });

    test('Scenario 2: Proactive Cleanup on Generic Error', async () => {
        const client = new MCPClient({
            identity,
            sessionId,
            serverId,
            serverUrl,
            callbackUrl,
        });

        // Mock to throw generic error
        (client as any).initialize = async function() {
            this.oauthProvider = { 
                tokens: async () => ({ access_token: 'valid' }),
                isTokenExpired: () => false
            };
            this.client = { connect: async () => {} }; // Needs to exist to pass check
        };
        (client as any).getValidTokens = async () => true;
        (client as any).tryConnect = async () => {
            throw new Error('ECONNREFUSED');
        };

        let removeSessionCalled = false;
        mockStorage.removeSession = async (id, sId) => {
            if (id === identity && sId === sessionId) removeSessionCalled = true;
        };

        await expect(client.connect()).rejects.toThrow('ECONNREFUSED');
        expect(removeSessionCalled).toBe(true);
    });

    test('Scenario 3: Proactive Cleanup on Terminal Auth Failure (no URL)', async () => {
        const client = new MCPClient({
            identity,
            sessionId,
            serverId,
            serverUrl,
            callbackUrl,
        });

        // Mock to throw Unauthorized without an auth URL
        (client as any).initialize = async function() {
            this.oauthProvider = { 
                tokens: async () => null, 
                authUrl: '' 
            };
            this.client = { connect: async () => {} };
        };
        (client as any).getValidTokens = async () => {
            throw new SDKUnauthorizedError('Unauthorized');
        };

        let removeSessionCalled = false;
        mockStorage.removeSession = async (id, sId) => {
            if (id === identity && sId === sessionId) removeSessionCalled = true;
        };

        await expect(client.connect()).rejects.toThrow('OAuth authorization URL not available');
        expect(removeSessionCalled).toBe(true);
    });

    test('Scenario 4: Short-lived Pending State (active: false, short TTL)', async () => {
        const client = new MCPClient({
            identity,
            sessionId,
            serverId,
            serverUrl,
            callbackUrl,
        });

        // Mock to throw Unauthorized WITH an auth URL
        (client as any).initialize = async function() {
            this.oauthProvider = { 
                tokens: async () => null,
                authUrl: 'http://auth.url'
            };
            this.client = { connect: async () => {} };
        };
        (client as any).getValidTokens = async () => {
            throw new SDKUnauthorizedError('Unauthorized');
        };

        let savedWithTtl = 0;
        let savedWithActive = true;
        
        (client as any).saveSession = async (ttl: number, active: boolean) => {
            savedWithTtl = ttl;
            savedWithActive = active;
        };

        await expect(client.connect()).rejects.toThrow('OAuth authorization required');
        
        expect(savedWithActive).toBe(false);
        expect(savedWithTtl).toBe(Math.floor(STATE_EXPIRATION_MS / 1000));
    });
});
