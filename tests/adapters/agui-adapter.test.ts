import { test, expect } from '@playwright/test';
import { AguiAdapter } from '../../src/adapters/agui-adapter';
import { MCPClient } from '../../src/server/mcp/oauth-client';

class MockMCPClient {
  private connected = true;
  private serverId = 'test-server';
  private sessionId = 'test-session';
  public callToolCalls: Array<{ name: string; args: any }> = [];

  isConnected() {
    return this.connected;
  }

  getServerId() {
    return this.serverId;
  }

  getSessionId() {
    return this.sessionId;
  }

  async listTools() {
    return {
      tools: [
        {
          name: 'get-time',
          description: 'Returns the current server time as an ISO 8601 string.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
          _meta: {
            ui: { resourceUri: 'ui://get-time/mcp-app.html' },
          },
        },
      ],
    };
  }

  async callTool(name: string, args: Record<string, unknown>) {
    this.callToolCalls.push({ name, args });
    return {
      content: [{ type: 'text' as const, text: '2026-02-02T00:00:00.000Z' }],
      _meta: { ui: { resourceUri: 'ui://get-time/mcp-app.html' } },
    };
  }
}

test.describe('AguiAdapter', () => {
  test('should execute tool via callTool in handler (not return listTools result)', async () => {
    const mockClient = new MockMCPClient() as unknown as MCPClient;
    const adapter = new AguiAdapter(mockClient);

    const tools = await adapter.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toContain('tool_testserv_get-time');

    const result = await tools[0].handler?.({});
    expect((mockClient as any).callToolCalls).toHaveLength(1);
    expect((mockClient as any).callToolCalls[0].name).toBe('get-time');
    expect(result).toEqual(
      expect.objectContaining({
        content: expect.any(Array),
      })
    );
  });

  test('should use custom prefix', async () => {
    const mockClient = new MockMCPClient() as unknown as MCPClient;
    const adapter = new AguiAdapter(mockClient, { prefix: 'custom' });

    const tools = await adapter.getTools();
    expect(tools[0].name).toContain('tool_custom_get-time');
  });

  test('should handle disconnected client', async () => {
    const mockClient = new MockMCPClient() as unknown as MCPClient;
    (mockClient as any).connected = false;

    const adapter = new AguiAdapter(mockClient);
    const tools = await adapter.getTools();
    expect(tools).toHaveLength(0);
  });

  test('should expose mcp_run_code when a programmatic runner is configured', async () => {
    const mockClient = new MockMCPClient() as unknown as MCPClient;
    const calls: any[] = [];
    const adapter = new AguiAdapter(mockClient, {
      programmaticToolRunner: {
        runCode: async (input: any) => {
          calls.push(input);
          return {
            isError: false,
            output: { ok: true },
            trace: {
              toolCalls: [],
              durationMs: 1,
              finalOutputTruncated: false,
            },
          };
        },
      } as any,
    });

    const tools = await adapter.getTools();
    const runCodeTool = tools.find((tool) => tool.name === 'mcp_run_code');

    expect(runCodeTool).toBeTruthy();

    const result = await runCodeTool!.handler?.({
      code: 'return { ok: true }',
      allowedTools: ['get-time'],
    });

    expect(result).toEqual({
      isError: false,
      output: { ok: true },
      trace: {
        toolCalls: [],
        durationMs: 1,
        finalOutputTruncated: false,
      },
    });
    expect(calls).toEqual([
      {
        code: 'return { ok: true }',
        allowedTools: ['get-time'],
      },
    ]);
  });

  test('should expose execute_python when a python code interpreter runtime is configured', async () => {
    const mockClient = new MockMCPClient() as unknown as MCPClient;
    const calls: any[] = [];
    const adapter = new AguiAdapter(mockClient, {
      pythonCodeInterpreterRuntime: {
        runPython: async (input: any) => {
          calls.push(input);
          return {
            results: [{ text: '42' }],
            stdout: ['hello'],
            stderr: [],
          };
        },
      } as any,
    });

    const tools = await adapter.getTools();
    const pythonTool = tools.find((tool) => tool.name === 'execute_python');

    expect(pythonTool).toBeTruthy();

    const result = await pythonTool!.handler?.({
      code: 'print("hello")\n42',
    });

    expect(result).toEqual({
      results: [{ text: '42' }],
      stdout: ['hello'],
      stderr: [],
    });
    expect(calls).toEqual([{ code: 'print("hello")\n42' }]);
  });
});


