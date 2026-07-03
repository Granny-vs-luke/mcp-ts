/**
 * Tests for the `allTools` field added to the `tools_discovered` SSE event.
 *
 * Changes covered:
 * - `listPolicyFilteredTools` emits `allTools` (full list) alongside the
 *   policy-filtered `tools` list in the `tools_discovered` event.
 * - `setToolPolicy` also emits `allTools` in the follow-up event so the
 *   management UI can immediately render correct checkboxes without an RPC.
 * - `allTools` contains ALL remote tools regardless of policy.
 * - `tools` contains only the policy-permitted subset.
 * - The two lists are emitted together in a single event (no second event).
 */

import { test, expect } from '@playwright/test';
import { SSEConnectionManager } from '../src/server/handlers/sse-handler';
import { _setStorageInstanceForTesting } from '../src/server/storage';
import { MemoryStorageBackend } from '../src/server/storage/memory-backend';

/** All tools the fake remote MCP server exposes */
const ALL_REMOTE_TOOLS = [
  { name: 'read_file',   description: 'Read a file',   inputSchema: { type: 'object', properties: {} } },
  { name: 'write_file',  description: 'Write a file',  inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_file', description: 'Delete a file', inputSchema: { type: 'object', properties: {} } },
];

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'alltools-session',
    userId: 'alltools-user',
    serverId: 'fs-server',
    serverName: 'Filesystem',
    serverUrl: 'https://example.com/mcp',
    callbackUrl: 'https://app.local/oauth/callback',
    transportType: 'streamable-http' as const,
    createdAt: Date.now(),
    status: 'active' as const,
    ...overrides,
  };
}

/** Fake in-memory MCP client that serves ALL_REMOTE_TOOLS */
function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: () => true,
    getSessionId: () => 'alltools-session',
    getServerId: () => 'fs-server',
    getServerName: () => 'Filesystem',
    getServerUrl: () => 'https://example.com/mcp',
    fetchTools: async () => ({ tools: ALL_REMOTE_TOOLS }),
    listTools: async () => ({ tools: ALL_REMOTE_TOOLS }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    disconnect: async () => {},
    ...overrides,
  };
}

test.describe('tools_discovered event — allTools field', () => {
  test.afterEach(() => {
    _setStorageInstanceForTesting(null);
  });

  test('listTools RPC emits tools_discovered with allTools containing the full tool list', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession({
      toolPolicy: {
        mode: 'denylist',
        toolIds: ['fs-server::delete_file'],
        updatedAt: Date.now(),
      },
    }) as any);

    const emittedEvents: any[] = [];
    const manager = new SSEConnectionManager(
      { userId: 'alltools-user' },
      (event) => emittedEvents.push(event),
    );
    (manager as any).clients.set('alltools-session', fakeClient());

    await manager.handleRequest({
      id: 'list',
      method: 'listTools',
      params: { sessionId: 'alltools-session' },
    } as any);

    const discovery = emittedEvents.find((e) => e.type === 'tools_discovered');
    expect(discovery).toBeDefined();

    // `tools` must be the policy-filtered list (delete_file blocked)
    expect(discovery.tools.map((t: any) => t.name)).toEqual(['read_file', 'write_file']);

    // `allTools` must contain ALL three tools regardless of policy
    expect(discovery.allTools).toBeDefined();
    expect(discovery.allTools.map((t: any) => t.name)).toEqual(
      ['read_file', 'write_file', 'delete_file']
    );

    await manager.dispose();
  });

  test('setToolPolicy emits tools_discovered with allTools after policy update', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    // Start with no policy (all tools allowed)
    await storage.create(activeSession() as any);

    const emittedEvents: any[] = [];
    const manager = new SSEConnectionManager(
      { userId: 'alltools-user' },
      (event) => emittedEvents.push(event),
    );
    (manager as any).clients.set('alltools-session', fakeClient());

    // Update policy to only allow read_file
    await manager.handleRequest({
      id: 'set-policy',
      method: 'setToolPolicy',
      params: {
        sessionId: 'alltools-session',
        toolPolicy: { mode: 'allowlist', toolIds: ['fs-server::read_file'] },
      },
    } as any);

    const discovery = emittedEvents.find((e) => e.type === 'tools_discovered');
    expect(discovery).toBeDefined();

    // `tools` must only contain allowed tools
    expect(discovery.tools.map((t: any) => t.name)).toEqual(['read_file']);

    // `allTools` must still contain all three (for the UI to render blocked tools)
    expect(discovery.allTools).toBeDefined();
    expect(discovery.allTools.map((t: any) => t.name)).toEqual(
      ['read_file', 'write_file', 'delete_file']
    );

    await manager.dispose();
  });

  test('tools and allTools are the same when policy mode is "all"', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    // No policy — all tools allowed
    await storage.create(activeSession() as any);

    const emittedEvents: any[] = [];
    const manager = new SSEConnectionManager(
      { userId: 'alltools-user' },
      (event) => emittedEvents.push(event),
    );
    (manager as any).clients.set('alltools-session', fakeClient());

    await manager.handleRequest({
      id: 'list-all',
      method: 'listTools',
      params: { sessionId: 'alltools-session' },
    } as any);

    const discovery = emittedEvents.find((e) => e.type === 'tools_discovered');
    expect(discovery).toBeDefined();

    const toolNames = discovery.tools.map((t: any) => t.name);
    const allToolNames = discovery.allTools.map((t: any) => t.name);

    expect(toolNames).toEqual(['read_file', 'write_file', 'delete_file']);
    expect(allToolNames).toEqual(toolNames);

    await manager.dispose();
  });

  test('only one tools_discovered event is emitted per listTools call', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession() as any);

    const emittedEvents: any[] = [];
    const manager = new SSEConnectionManager(
      { userId: 'alltools-user' },
      (event) => emittedEvents.push(event),
    );
    (manager as any).clients.set('alltools-session', fakeClient());

    await manager.handleRequest({
      id: 'list-once',
      method: 'listTools',
      params: { sessionId: 'alltools-session' },
    } as any);

    const discoveryEvents = emittedEvents.filter((e) => e.type === 'tools_discovered');
    expect(discoveryEvents).toHaveLength(1);

    await manager.dispose();
  });

  test('ToolPolicyGateway listAllTools bypasses policy and returns full tool list', async () => {
    const storage = new MemoryStorageBackend();
    _setStorageInstanceForTesting(storage);
    await storage.create(activeSession({
      toolPolicy: {
        mode: 'allowlist',
        toolIds: ['fs-server::read_file'],
        updatedAt: Date.now(),
      },
    }) as any);

    const { createToolPolicyGateway } = await import('../src/server/mcp/tool-policy-gateway');
    const gateway = createToolPolicyGateway('alltools-user', 'alltools-session', fakeClient() as any);

    const filtered = await gateway.listTools();
    expect(filtered.tools.map((t) => t.name)).toEqual(['read_file']); // policy applied

    const all = await gateway.listAllTools();
    expect(all.tools.map((t) => t.name)).toEqual(
      ['read_file', 'write_file', 'delete_file'] // no policy applied
    );
  });
});
