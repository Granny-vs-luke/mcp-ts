import { test, expect } from '@playwright/test';
import { MultiSessionClient } from '../src/server/mcp/multi-session-client';
import { MCPClient } from '../src/server/mcp/oauth-client';
import { storage, _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';

test.describe('MultiSessionClient', () => {
    const identity = 'test-identity';
    
    // Save original MCPClient methods to restore later
    const originalConnect = (MCPClient.prototype as any).connect;
    const originalDisconnect = (MCPClient.prototype as any).disconnect;
    const originalIsConnected = (MCPClient.prototype as any).isConnected;
    const originalGetSessionId = (MCPClient.prototype as any).getSessionId;

    test.beforeEach(() => {
        // Mock getSessionId to read from the internal state created in constructor
        (MCPClient.prototype as any).getSessionId = function() {
            return (this as any).sessionId;
        };
        (MCPClient.prototype as any).isConnected = function() {
            return (this as any)._mockConnected || false;
        };
        (MCPClient.prototype as any).disconnect = function() {
            (this as any)._mockConnected = false;
        };
    });

    test.afterEach(() => {
        _setStorageInstanceForTesting(null);
        (MCPClient.prototype as any).connect = originalConnect;
        (MCPClient.prototype as any).disconnect = originalDisconnect;
        (MCPClient.prototype as any).isConnected = originalIsConnected;
        (MCPClient.prototype as any).getSessionId = originalGetSessionId;
    });

    test('should fetch active sessions and establish connections in batches', async () => {
        let connectCallCount = 0;
        
        // Mock connect to succeed automatically
        (MCPClient.prototype as any).connect = async function() {
            connectCallCount++;
            (this as any)._mockConnected = true;
        };

        const mockStorage = new MemoryStorageBackend();
        
        // Let's create 6 sessions to force it beyond a single BATCH_SIZE (which is 5)
        const mockSessions = Array.from({ length: 6 }).map((_, i) => ({
            sessionId: `session-${i}`,
            serverId: `server-${i}`,
            serverUrl: `http://localhost/server-${i}`,
            callbackUrl: `http://localhost/callback-${i}`,
            active: true   // mark as fully established sessions
        }));
        
        mockStorage.getUserSession = async () => mockSessions as any;
        _setStorageInstanceForTesting(mockStorage);

        const multiClient = new MultiSessionClient(identity);
        await multiClient.connect();

        const clients = multiClient.getClients();
        expect(connectCallCount).toBe(6);
        expect(clients.length).toBe(6);
        expect(clients[0].isConnected()).toBe(true);
    });

    test('should prevent duplicate connection attempts via connectionPromises lock', async () => {
        let connectCallCount = 0;
        
        let releaseLock: () => void;
        const lockPromise = new Promise<void>(r => { releaseLock = r; });

        // Mock connect to wait for the explicit release to guarantee overlapping
        (MCPClient.prototype as any).connect = async function() {
            connectCallCount++;
            await lockPromise; 
            (this as any)._mockConnected = true;
        };

        const multiClient = new MultiSessionClient(identity, { timeout: 10000 });
        
        const testSession = {
            sessionId: 'concurrent-session',
            serverId: 'server-1',
            serverUrl: 'http://localhost/server',
            callbackUrl: 'http://localhost/callback'
        } as any;
        
        // Call explicit private connectSession directly to simulate overlapping calls 
        const p1 = (multiClient as any).connectSession(testSession);
        const p2 = (multiClient as any).connectSession(testSession);
        
        expect((multiClient as any).connectionPromises.has('concurrent-session')).toBe(true);

        releaseLock!();
        await Promise.all([p1, p2]);

        // Even though we fired connectSession twice, it should only spin up 1 physical connection 
        expect(connectCallCount).toBe(1);
        expect(multiClient.getClients().length).toBe(1);
    });

    test('should apply retry logic when connections fail', async () => {
        let attemptCount = 0;
        
        (MCPClient.prototype as any).connect = async function() {
            attemptCount++;
            if (attemptCount < 2) {
                // Fail on the first attempt
                throw new Error('Simulated network failure');
            }
            // Succeed on the second
            (this as any)._mockConnected = true;
        };

        const multiClient = new MultiSessionClient(identity, { maxRetries: 2, retryDelay: 50 });
        
        const testSession = {
            sessionId: 'retry-session',
            serverId: 'server-1',
            serverUrl: 'http://localhost/server',
            callbackUrl: 'http://localhost/cb'
        } as any;
        
        await (multiClient as any).connectSession(testSession);
        
        // Should have retried exactly once after the failure
        expect(attemptCount).toBe(2);
        
        const clients = multiClient.getClients();
        expect(clients.length).toBe(1);
        expect(clients[0].isConnected()).toBe(true);
    });

    test('should give up and log error if max retries are exceeded', async () => {
        let attemptCount = 0;
        
        (MCPClient.prototype as any).connect = async function() {
            attemptCount++;
            throw new Error('Persistent failure');
        };

        const consoleSpy = "error" in console ? console.error : undefined;
        let loggedErrors = 0;

        console.error = () => { loggedErrors++; };

        try {
            const multiClient = new MultiSessionClient(identity, { maxRetries: 1, retryDelay: 10 });
            
            const testSession = {
                sessionId: 'fail-session',
                serverId: 'server-failed',
                serverUrl: 'http://loc/fail',
                callbackUrl: 'http://loc/cb'
            } as any;
            
            await (multiClient as any).connectSession(testSession);
            
            // Base attempt + 1 retry = 2 attempts total
            expect(attemptCount).toBe(2);
            expect(multiClient.getClients().length).toBe(0);
            expect(loggedErrors).toBeGreaterThan(0);
        } finally {
            if (consoleSpy) console.error = consoleSpy;
        }
    });

    test('should properly disconnect and clear client cache', async () => {
        (MCPClient.prototype as any).connect = async function() {
            (this as any)._mockConnected = true;
        };

        const testSession = {
            sessionId: 'disconnect-test',
            serverId: 'srv',
            serverUrl: 'url',
            callbackUrl: 'url'
        } as any;

        const multiClient = new MultiSessionClient(identity);
        await (multiClient as any).connectSession(testSession);
        
        const client = multiClient.getClients()[0];
        expect(client.isConnected()).toBe(true);

        multiClient.disconnect();

        expect(multiClient.getClients().length).toBe(0);
        expect(client.isConnected()).toBe(false); // Because mock disconnect sets it to false
    });
});
