import { test, expect } from '@playwright/test';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';
import { createToolPolicyGateway } from '../src/server/mcp/tool-policy-gateway';
import { SSEConnectionManager } from '../src/server/handlers/sse-handler';

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'policy-session',
    userId: 'user-policy',
    serverId: 'github',
    serverName: 'GitHub',
    serverUrl: 'https://example.com/mcp',
    callbackUrl: 'https://app.local/oauth/callback',
    transportType: 'streamable-http' as const,
    createdAt: Date.now(),
    status: 'active' as const,
    ...overrides,
  };
}

function rawClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: () => true,
    getSessionId: () => 'policy-session',
    getServerId: () => 'github',
    getServerName: () => 'GitHub',
    listTools: async () => ({
      tools: [
        { name: 'get_issue', description: 'Read issue' },
        { name: 'create_issue', description: 'Write issue' },
      ],
    }),
    callTool: async () => ({ content: [{ type: 'text', text: 'called' }] }),
    disconnect: async () => {},
    ...overrides,
  };
}

test.describe('MCP session tool policy', () => {
  test.afterEach(() => {
    _setStorageInstanceForTesting(null);
  });

  test('ToolPolicyGateway listTools filters tools with allowlist policy', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession({
      toolPolicy: {
        mode: 'allowlist',
        toolIds: ['github::get_issue'],
        updatedAt: 1780076500000,
      },
    }) as any);

    const gateway = createToolPolicyGateway('user-policy', 'policy-session', rawClient() as any);

    const result = await gateway.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(['get_issue']);
  });

  test('ToolPolicyGateway listTools filters tools with denylist policy', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession({
      toolPolicy: {
        mode: 'denylist',
        toolIds: ['github::create_issue'],
        updatedAt: 1780076500000,
      },
    }) as any);

    const gateway = createToolPolicyGateway('user-policy', 'policy-session', rawClient() as any);

    const result = await gateway.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(['get_issue']);
  });

  test('ToolPolicyGateway callTool rejects tools outside allowlist before downstream request', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession({
      toolPolicy: {
        mode: 'allowlist',
        toolIds: ['github::get_issue'],
        updatedAt: 1780076500000,
      },
    }) as any);

    let downstreamCalls = 0;
    const gateway = createToolPolicyGateway('user-policy', 'policy-session', rawClient({
      callTool: async () => {
        downstreamCalls += 1;
        return { content: [{ type: 'text', text: 'called' }] };
      },
    }) as any);

    await expect(gateway.callTool('create_issue', {})).rejects.toThrow(
      'Tool "create_issue" is not allowed for this MCP session'
    );
    expect(downstreamCalls).toBe(0);
  });

  test('SSE listSessions includes toolPolicy and updateSessionToolPolicy persists changes', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession() as any);

    const manager = new SSEConnectionManager({ userId: 'user-policy' }, () => {});
    (manager as any).clients.set('policy-session', rawClient());

    const update = await manager.handleRequest({
      id: 'update-policy',
      method: 'updateSessionToolPolicy',
      params: {
        sessionId: 'policy-session',
        toolPolicy: {
          mode: 'allowlist',
          toolIds: ['github::get_issue'],
        },
      },
    } as any);

    expect((update as any).error).toBeUndefined();
    expect((update as any).result.toolPolicy).toEqual({
      mode: 'allowlist',
      toolIds: ['github::get_issue'],
      updatedAt: expect.any(Number),
    });
    expect((update as any).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_issue']);

    const list = await manager.handleRequest({
      id: 'list-sessions',
      method: 'listSessions',
    } as any);

    expect((list as any).error).toBeUndefined();
    expect((list as any).result.sessions[0].toolPolicy).toEqual(
      (update as any).result.toolPolicy
    );

    const access = await manager.handleRequest({
      id: 'tool-access',
      method: 'getSessionToolAccess',
      params: { sessionId: 'policy-session' },
    } as any);

    expect((access as any).error).toBeUndefined();
    expect((access as any).result.tools.map((tool: { name: string; toolId: string; allowed: boolean }) => ({
      name: tool.name,
      toolId: tool.toolId,
      allowed: tool.allowed,
    }))).toEqual([
      { name: 'get_issue', toolId: 'github::get_issue', allowed: true },
      { name: 'create_issue', toolId: 'github::create_issue', allowed: false },
    ]);

    await manager.dispose();
  });

  test('SSE callTool rejects blocked tools before downstream request', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession({
      toolPolicy: {
        mode: 'denylist',
        toolIds: ['github::create_issue'],
        updatedAt: 1780076500000,
      },
    }) as any);

    let downstreamCalls = 0;
    const manager = new SSEConnectionManager({ userId: 'user-policy' }, () => {});
    (manager as any).clients.set('policy-session', rawClient({
      callTool: async () => {
        downstreamCalls += 1;
        return { content: [{ type: 'text', text: 'called' }] };
      },
    }));

    const response = await manager.handleRequest({
      id: 'call-policy',
      method: 'callTool',
      params: {
        sessionId: 'policy-session',
        toolName: 'create_issue',
        toolArgs: {},
      },
    } as any);

    expect((response as any).result).toBeUndefined();
    expect((response as any).error?.message).toBe('Tool "create_issue" is not allowed for this MCP session');
    expect(downstreamCalls).toBe(0);

    await manager.dispose();
  });
});

