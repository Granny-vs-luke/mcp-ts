import { test, expect } from '@playwright/test';
import { JavaScriptSandboxRuntime } from '../src/server/programmatic/javascript-sandbox-runtime';

test.describe('JavaScriptSandboxRuntime', () => {
  test('runs async JavaScript with injected tools', async () => {
    const runtime = new JavaScriptSandboxRuntime();

    const result = await runtime.run({
      code: `
        const result = await tools.sum_numbers({ values: [4, 6] });
        return result.total;
      `,
      timeoutMs: 1000,
      tools: {
        sum_numbers: async (args) => {
          const values = args.values as number[];
          return { total: values.reduce((sum, value) => sum + value, 0) };
        },
      },
    });

    expect(result.output).toBe(10);
  });

  test('does not expose Node process, require, or fetch globals', async () => {
    const runtime = new JavaScriptSandboxRuntime();

    await expect(
      runtime.run({
        code: `
          return {
            processType: typeof process,
            requireType: typeof require,
            fetchType: typeof fetch
          };
        `,
        timeoutMs: 1000,
        tools: {},
      })
    ).resolves.toEqual({
      output: {
        processType: 'undefined',
        requireType: 'undefined',
        fetchType: 'undefined',
      },
    });
  });

  test('times out synchronous runaway code', async () => {
    const runtime = new JavaScriptSandboxRuntime();

    await expect(
      runtime.run({
        code: 'while (true) {}',
        timeoutMs: 50,
        tools: {},
      })
    ).rejects.toThrow(/timed out/i);
  });
});
