import { test, expect } from '@playwright/test';
import { ProgrammaticToolBridge } from '../src/server/programmatic/tool-bridge';

function createClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  return {
    calls,
    client: {
      isConnected: () => true,
      getServerId: () => 'test-server',
      getSessionId: () => 'test-session',
      listTools: async () => ({
        tools: [
          {
            name: 'sum_numbers',
            description: 'Sum numbers',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'secret_lookup',
            description: 'Read secrets',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { total: (args.values as number[]).reduce((sum, value) => sum + value, 0) };
      },
    },
  };
}

test.describe('ProgrammaticToolBridge', () => {
  test('executes allowed tool bridge requests', async () => {
    const { client, calls } = createClient();
    const bridge = new ProgrammaticToolBridge([client], {
      allowedTools: ['sum_numbers'],
      bridgeToken: 'secret-token',
    });

    const response = await bridge.handleRequest(
      new Request('https://example.com/api/mcp/tool-bridge', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          toolName: 'sum_numbers',
          args: { values: [2, 8] },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { total: 10 } });
    expect(calls).toEqual([{ name: 'sum_numbers', args: { values: [2, 8] } }]);
  });

  test('rejects invalid bridge tokens before executing tools', async () => {
    const { client, calls } = createClient();
    const bridge = new ProgrammaticToolBridge([client], {
      allowedTools: ['sum_numbers'],
      bridgeToken: 'secret-token',
    });

    const response = await bridge.handleRequest(
      new Request('https://example.com/api/mcp/tool-bridge', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          toolName: 'sum_numbers',
          args: { values: [2, 8] },
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ isError: true, error: 'Invalid programmatic tool bridge token.' });
    expect(calls).toEqual([]);
  });

  test('rejects disallowed tools', async () => {
    const { client, calls } = createClient();
    const bridge = new ProgrammaticToolBridge([client], {
      allowedTools: ['sum_numbers'],
    });

    const response = await bridge.handleRequest(
      new Request('https://example.com/api/mcp/tool-bridge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolName: 'secret_lookup',
          args: {},
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ isError: true, error: 'Tool "secret_lookup" is not allowed for programmatic execution.' });
    expect(calls).toEqual([]);
  });
});
