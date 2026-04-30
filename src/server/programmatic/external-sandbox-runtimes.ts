import type {
  SandboxRunInput,
  SandboxRunResult,
  SandboxRuntime,
} from '../../shared/programmatic-tool-runner.js';

const RESULT_MARKER = '__MCP_TS_RESULT__';

export interface SandboxedJavaScriptOptions {
  code: string;
  bridgeUrl?: string;
  bridgeToken?: string;
}

export interface E2BSandboxRuntimeOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  apiKey?: string;
  cleanup?: boolean;
  sandboxFactory?: () => Promise<any>;
  e2bModule?: any;
  runCodeOptions?: Record<string, unknown>;
}

export interface E2BPythonCodeInterpreterRuntimeOptions {
  apiKey?: string;
  cleanup?: boolean;
  sandboxFactory?: () => Promise<any>;
  e2bModule?: any;
  runCodeOptions?: Record<string, unknown>;
}

export interface E2BPythonRunInput {
  code: string;
}

export interface E2BPythonRunResult {
  results: unknown[];
  stdout: string[];
  stderr: string[];
}

export interface VercelSandboxRuntimeOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  cleanup?: boolean;
  sandboxFactory?: () => Promise<any>;
  createOptions?: Record<string, unknown>;
  filePath?: string;
}

export function buildSandboxedJavaScript(options: SandboxedJavaScriptOptions): string {
  const bridgeUrl = JSON.stringify(options.bridgeUrl ?? '');
  const bridgeToken = JSON.stringify(options.bridgeToken ?? '');
  const authorizationHeader = options.bridgeToken ? JSON.stringify(`Bearer ${options.bridgeToken}`) : 'null';

  return `
const __mcpTsBridgeUrl = ${bridgeUrl};
const __mcpTsBridgeToken = ${bridgeToken};
const __mcpTsAuthorizationHeader = ${authorizationHeader};

const tools = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string') return undefined;

    return async (args = {}) => {
      if (!__mcpTsBridgeUrl) {
        throw new Error('Programmatic tool calls require a bridgeUrl for external sandbox runtimes.');
      }

      const response = await fetch(__mcpTsBridgeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(__mcpTsAuthorizationHeader ? { authorization: __mcpTsAuthorizationHeader } : {}),
        },
        body: JSON.stringify({ toolName: property, args }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload.isError) {
        throw new Error(payload.error || \`Tool bridge request failed with status \${response.status}\`);
      }

      return Object.prototype.hasOwnProperty.call(payload, 'result') ? payload.result : payload.output;
    };
  },
});

try {
  const output = await (async () => {
${indentUserCode(options.code)}
  })();
  console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ output }));
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  throw error;
}
`;
}

export class E2BSandboxRuntime implements SandboxRuntime {
  constructor(private options: E2BSandboxRuntimeOptions = {}) {}

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const sandbox = await this.createSandbox();
    const code = buildSandboxedJavaScript({
      code: input.code,
      bridgeUrl: this.options.bridgeUrl,
      bridgeToken: this.options.bridgeToken,
    });

    try {
      const execution = await sandbox.runCode(code, {
        language: 'javascript',
        timeout: input.timeoutMs,
        ...this.options.runCodeOptions,
      });
      const stdout = collectExecutionText(execution);

      return {
        output: parseMarkedOutput(stdout),
        stdout,
      };
    } finally {
      if (this.options.cleanup !== false) {
        await stopSandbox(sandbox);
      }
    }
  }

  private async createSandbox(): Promise<any> {
    if (this.options.sandboxFactory) {
      return this.options.sandboxFactory();
    }

    const mod = this.options.e2bModule ?? await optionalImport('@e2b/code-interpreter');
    return mod.Sandbox.create(this.options.apiKey ? { apiKey: this.options.apiKey } : undefined);
  }
}

export class E2BPythonCodeInterpreterRuntime {
  constructor(private options: E2BPythonCodeInterpreterRuntimeOptions = {}) {}

  async runPython(input: E2BPythonRunInput): Promise<E2BPythonRunResult> {
    const sandbox = await this.createSandbox();
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const execution = await sandbox.runCode(input.code, {
        onStdout: (message: string) => stdout.push(message),
        onStderr: (message: string) => stderr.push(message),
        ...this.options.runCodeOptions,
      });

      if (execution?.error) {
        throw new Error(execution.error.value ?? execution.error.message ?? String(execution.error));
      }

      const results = Array.isArray(execution?.results)
        ? execution.results.map((result: any) => {
            return typeof result?.toJSON === 'function' ? result.toJSON() : result;
          })
        : [];

      return {
        results,
        stdout,
        stderr,
      };
    } finally {
      if (this.options.cleanup !== false) {
        await stopSandbox(sandbox);
      }
    }
  }

  private async createSandbox(): Promise<any> {
    if (this.options.sandboxFactory) {
      return this.options.sandboxFactory();
    }

    const mod = this.options.e2bModule ?? await optionalImport('@e2b/code-interpreter');
    return mod.Sandbox.create(this.options.apiKey ? { apiKey: this.options.apiKey } : undefined);
  }
}

export class VercelSandboxRuntime implements SandboxRuntime {
  constructor(private options: VercelSandboxRuntimeOptions = {}) {}

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const sandbox = await this.createSandbox();
    const filePath = this.options.filePath ?? 'mcp-run-code.mjs';
    const code = buildSandboxedJavaScript({
      code: input.code,
      bridgeUrl: this.options.bridgeUrl,
      bridgeToken: this.options.bridgeToken,
    });

    try {
      await sandbox.writeFiles([{ path: filePath, content: Buffer.from(code) }]);
      const command = await sandbox.runCommand('node', [filePath]);
      const stdout = typeof command.stdout === 'function' ? await command.stdout() : '';
      const stderr = typeof command.stderr === 'function' ? await command.stderr() : undefined;

      return {
        output: parseMarkedOutput(stdout),
        stdout,
        stderr,
      };
    } finally {
      if (this.options.cleanup !== false) {
        await stopSandbox(sandbox);
      }
    }
  }

  private async createSandbox(): Promise<any> {
    if (this.options.sandboxFactory) {
      return this.options.sandboxFactory();
    }

    const mod = await optionalImport('@vercel/sandbox');
    return mod.Sandbox.create(this.options.createOptions ?? {});
  }
}

function indentUserCode(code: string): string {
  return code
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function parseMarkedOutput(stdout: string): unknown {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith(RESULT_MARKER));

  if (!line) {
    throw new Error(`Sandbox output did not contain ${RESULT_MARKER}.`);
  }

  const payload = JSON.parse(line.slice(RESULT_MARKER.length));
  return payload.output;
}

function collectExecutionText(execution: any): string {
  const parts: string[] = [];

  if (typeof execution?.text === 'string') {
    parts.push(execution.text);
  }

  if (Array.isArray(execution?.logs?.stdout)) {
    parts.push(...execution.logs.stdout);
  } else if (typeof execution?.logs?.stdout === 'string') {
    parts.push(execution.logs.stdout);
  }

  if (Array.isArray(execution?.results)) {
    for (const result of execution.results) {
      if (typeof result?.text === 'string') {
        parts.push(result.text);
      }
    }
  }

  return parts.join('\n');
}

async function stopSandbox(sandbox: any): Promise<void> {
  if (typeof sandbox?.kill === 'function') {
    await sandbox.kill();
    return;
  }

  if (typeof sandbox?.close === 'function') {
    await sandbox.close();
    return;
  }

  if (typeof sandbox?.stop === 'function') {
    await sandbox.stop();
  }
}

async function optionalImport(packageName: string): Promise<any> {
  try {
    const dynamicImport = new Function('packageName', 'return import(packageName)') as (name: string) => Promise<any>;
    return await dynamicImport(packageName);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Optional sandbox package "${packageName}" is not installed or could not be loaded: ${errorMessage}`);
  }
}
