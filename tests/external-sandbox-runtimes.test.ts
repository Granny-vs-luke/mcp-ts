import { test, expect } from '@playwright/test';
import {
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
