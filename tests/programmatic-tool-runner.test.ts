import { test, expect } from '@playwright/test';
import {
  ProgrammaticToolRunner,
  type SandboxRuntime,
  type SandboxRunInput,
} from '../src/shared/programmatic-tool-runner';

function createClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  return {
    calls,
    client: {
      isConnected: () => true,
      getServerId: () => 'test-server',
      getServerName: () => 'Test Server',
      getSessionId: () => 'test-session',
      listTools: async () => ({
        tools: [
          {
            name: 'sum_numbers',
            description: 'Sum a list of numbers',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'secret_lookup',
            description: 'Read sensitive data',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'large_report',
            description: 'Return a large report',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });

        if (name === 'sum_numbers') {
          const values = args.values as number[];
          return { total: values.reduce((sum, value) => sum + value, 0) };
        }

        if (name === 'secret_lookup') {
          return { token: 'should-not-be-readable' };
        }

        if (name === 'large_report') {
          return 'x'.repeat(200);
        }

        throw new Error(`Unexpected tool ${name}`);
      },
    },
  };
}

function createRuntime(handler: (input: SandboxRunInput) => Promise<unknown>): SandboxRuntime {
  return {
    run: async (input) => ({
      output: await handler(input),
    }),
  };
}

test.describe('ProgrammaticToolRunner', () => {
  test('executes sandbox code with allowed MCP tools and records an audit trace', async () => {
    const { client, calls } = createClient();
    const runtime = createRuntime(async ({ tools }) => {
      return await tools.sum_numbers({ values: [2, 3, 5] });
    });
    const runner = new ProgrammaticToolRunner([client], {
      runtime,
      allowedTools: ['sum_numbers'],
    });

    const result = await runner.runCode({ code: 'return await tools.sum_numbers({ values: [2, 3, 5] })' });

    expect(result.isError).toBe(false);
    expect(result.output).toEqual({ total: 10 });
    expect(calls).toEqual([{ name: 'sum_numbers', args: { values: [2, 3, 5] } }]);
    expect(result.trace.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'sum_numbers',
        serverId: 'test-server',
        ok: true,
      }),
    ]);
  });

  test('rejects sandbox calls to tools outside allowedTools', async () => {
    const { client, calls } = createClient();
    const runtime = createRuntime(async ({ tools }) => {
      return await tools.secret_lookup({});
    });
    const runner = new ProgrammaticToolRunner([client], {
      runtime,
      allowedTools: ['sum_numbers'],
    });

    const result = await runner.runCode({ code: 'return await tools.secret_lookup({})' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('not allowed');
    expect(calls).toEqual([]);
    expect(result.trace.toolCalls).toHaveLength(0);
  });

  test('enforces maxToolCalls before executing extra calls', async () => {
    const { client, calls } = createClient();
    const runtime = createRuntime(async ({ tools }) => {
      await tools.sum_numbers({ values: [1] });
      return await tools.sum_numbers({ values: [2] });
    });
    const runner = new ProgrammaticToolRunner([client], {
      runtime,
      allowedTools: ['sum_numbers'],
      maxToolCalls: 1,
    });

    const result = await runner.runCode({ code: 'call twice' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('maxToolCalls');
    expect(calls).toEqual([{ name: 'sum_numbers', args: { values: [1] } }]);
    expect(result.trace.toolCalls).toHaveLength(1);
  });

  test('caps final output size without truncating intermediate tool results', async () => {
    const { client } = createClient();
    const runtime = createRuntime(async ({ tools }) => {
      const report = await tools.large_report({});
      return { report };
    });
    const runner = new ProgrammaticToolRunner([client], {
      runtime,
      allowedTools: ['large_report'],
      maxFinalOutputBytes: 40,
    });

    const result = await runner.runCode({ code: 'return large report' });

    expect(result.isError).toBe(false);
    expect(typeof result.output).toBe('string');
    expect(result.output as string).toContain('[truncated]');
    expect(result.trace.finalOutputTruncated).toBe(true);
  });
});
