import { test, expect } from '@playwright/test';
import {
  E2BPythonCodeInterpreterRuntime,
  E2BSandboxRuntime,
  VercelSandboxRuntime,
  buildSandboxedJavaScript,
} from '../src/server/programmatic/external-sandbox-runtimes';

test.describe('external sandbox runtimes', () => {
  test('buildSandboxedJavaScript injects a bridge-backed tools proxy', () => {
    const code = buildSandboxedJavaScript({
      code: 'return await tools.sum_numbers({ values: [1, 2] })',
      bridgeUrl: 'https://example.com/mcp-tool-bridge',
      bridgeToken: 'secret-token',
    });

    expect(code).toContain('const tools = new Proxy');
    expect(code).toContain('https://example.com/mcp-tool-bridge');
    expect(code).toContain('Bearer secret-token');
    expect(code).toContain('__MCP_TS_RESULT__');
  });

  test('E2BSandboxRuntime executes wrapped JavaScript and parses final output', async () => {
    const calls: any[] = [];
    const fakeSandbox = {
      runCode: async (code: string, opts: Record<string, unknown>) => {
        calls.push({ code, opts });
        return {
          text: '__MCP_TS_RESULT__{"output":{"ok":true}}',
        };
      },
      kill: async () => {
        calls.push({ kill: true });
      },
    };

    const runtime = new E2BSandboxRuntime({
      bridgeUrl: 'https://example.com/bridge',
      sandboxFactory: async () => fakeSandbox,
    });

    const result = await runtime.run({
      code: 'return { ok: true }',
      timeoutMs: 1000,
      tools: {},
    });

    expect(result.output).toEqual({ ok: true });
    expect(calls[0].opts).toEqual(expect.objectContaining({ language: 'javascript' }));
    expect(calls[0].code).toContain('https://example.com/bridge');
    expect(calls).toContainEqual({ kill: true });
  });

  test('E2BSandboxRuntime passes apiKey to Sandbox.create when no factory is provided', async () => {
    const calls: any[] = [];
    const runtime = new E2BSandboxRuntime({
      apiKey: 'e2b-key',
      bridgeUrl: 'https://example.com/bridge',
      e2bModule: {
        Sandbox: {
          create: async (options: Record<string, unknown>) => {
            calls.push({ create: options });
            return {
              runCode: async () => ({ text: '__MCP_TS_RESULT__{"output":{"ok":true}}' }),
              kill: async () => calls.push({ kill: true }),
            };
          },
        },
      },
    });

    await runtime.run({
      code: 'return { ok: true }',
      timeoutMs: 1000,
      tools: {},
    });

    expect(calls[0]).toEqual({ create: { apiKey: 'e2b-key' } });
  });

  test('E2BPythonCodeInterpreterRuntime returns notebook results and captured output', async () => {
    const calls: any[] = [];
    const fakeSandbox = {
      runCode: async (code: string, options: any) => {
        calls.push({ code, hasStdout: typeof options.onStdout === 'function', hasStderr: typeof options.onStderr === 'function' });
        options.onStdout('hello');
        options.onStderr('warning');
        return {
          results: [
            {
              toJSON: () => ({ text: '42' }),
            },
          ],
        };
      },
      kill: async () => {
        calls.push({ kill: true });
      },
    };
    const runtime = new E2BPythonCodeInterpreterRuntime({
      sandboxFactory: async () => fakeSandbox,
    });

    const result = await runtime.runPython({
      code: 'print("hello")\n42',
    });

    expect(result).toEqual({
      results: [{ text: '42' }],
      stdout: ['hello'],
      stderr: ['warning'],
    });
    expect(calls[0]).toEqual({ code: 'print("hello")\n42', hasStdout: true, hasStderr: true });
    expect(calls).toContainEqual({ kill: true });
  });

  test('E2BPythonCodeInterpreterRuntime throws E2B execution errors', async () => {
    const runtime = new E2BPythonCodeInterpreterRuntime({
      sandboxFactory: async () => ({
        runCode: async () => ({
          error: {
            value: 'boom',
          },
          results: [],
        }),
        kill: async () => undefined,
      }),
    });

    await expect(runtime.runPython({ code: 'raise Exception("boom")' })).rejects.toThrow('boom');
  });

  test('VercelSandboxRuntime writes a module, runs node, parses stdout, and stops', async () => {
    const calls: any[] = [];
    const fakeSandbox = {
      writeFiles: async (files: Array<{ path: string; content: Buffer }>) => {
        calls.push({ writeFiles: files.map((file) => ({ path: file.path, content: file.content.toString('utf8') })) });
      },
      runCommand: async (cmd: string, args: string[]) => {
        calls.push({ runCommand: { cmd, args } });
        return {
          stdout: async () => '__MCP_TS_RESULT__{"output":{"ok":true}}\n',
          stderr: async () => '',
        };
      },
      stop: async () => {
        calls.push({ stop: true });
      },
    };

    const runtime = new VercelSandboxRuntime({
      bridgeUrl: 'https://example.com/bridge',
      sandboxFactory: async () => fakeSandbox,
    });

    const result = await runtime.run({
      code: 'return { ok: true }',
      timeoutMs: 1000,
      tools: {},
    });

    expect(result.output).toEqual({ ok: true });
    expect(calls[0].writeFiles[0].path).toBe('mcp-run-code.mjs');
    expect(calls[0].writeFiles[0].content).toContain('https://example.com/bridge');
    expect(calls[1]).toEqual({ runCommand: { cmd: 'node', args: ['mcp-run-code.mjs'] } });
    expect(calls).toContainEqual({ stop: true });
  });
});
