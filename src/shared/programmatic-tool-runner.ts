import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolClient, ToolClientProvider } from './types.js';

export const PROGRAMMATIC_TOOL_NAME = 'mcp_run_code';
export const PYTHON_CODE_INTERPRETER_TOOL_NAME = 'execute_python';

export interface SandboxToolCall {
  (args: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxRunInput {
  code: string;
  tools: Record<string, SandboxToolCall>;
  timeoutMs: number;
}

export interface SandboxRunResult {
  output: unknown;
  stdout?: string;
  stderr?: string;
}

export interface SandboxRuntime {
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
}

export interface ProgrammaticAllowedTool {
  toolName: string;
  serverId?: string;
}

export type ProgrammaticAllowedToolInput = string | ProgrammaticAllowedTool;

export interface ProgrammaticToolRunnerOptions {
  runtime: SandboxRuntime;
  allowedTools?: ProgrammaticAllowedToolInput[];
  maxToolCalls?: number;
  maxParallelToolCalls?: number;
  timeoutMs?: number;
  maxToolResultBytes?: number;
  maxFinalOutputBytes?: number;
}

export interface ProgrammaticRunInput {
  code: string;
  allowedTools?: ProgrammaticAllowedToolInput[];
}

export interface ProgrammaticToolRunnerLike {
  runCode(input: ProgrammaticRunInput): Promise<ProgrammaticRunResult>;
}

export interface PythonCodeInterpreterRunInput {
  code: string;
}

export interface PythonCodeInterpreterRunResult {
  results: unknown[];
  stdout: string[];
  stderr: string[];
}

export interface PythonCodeInterpreterRuntimeLike {
  runPython(input: PythonCodeInterpreterRunInput): Promise<PythonCodeInterpreterRunResult>;
}

export interface ProgrammaticToolCallTrace {
  toolName: string;
  serverId: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ProgrammaticRunTrace {
  toolCalls: ProgrammaticToolCallTrace[];
  durationMs: number;
  finalOutputTruncated: boolean;
}

export interface ProgrammaticRunResult {
  isError: boolean;
  output?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
  trace: ProgrammaticRunTrace;
}

interface IndexedRuntimeTool {
  tool: Tool;
  client: ToolClient;
  serverId: string;
}

export type ProgrammaticToolClientInput = ToolClientProvider | ToolClient[];

const DEFAULT_MAX_TOOL_CALLS = 50;
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 200_000;
const DEFAULT_MAX_FINAL_OUTPUT_BYTES = 20_000;

export class ProgrammaticToolRunner {
  constructor(
    private clientInput: ProgrammaticToolClientInput,
    private options: ProgrammaticToolRunnerOptions
  ) {}

  async runCode(input: ProgrammaticRunInput): Promise<ProgrammaticRunResult> {
    const startedAt = Date.now();
    const trace: ProgrammaticRunTrace = {
      toolCalls: [],
      durationMs: 0,
      finalOutputTruncated: false,
    };

    try {
      const availableTools = await this.indexAvailableTools();
      const allowedKeys = this.resolveAllowedKeys(availableTools, input.allowedTools);
      const tools = this.createSandboxTools(availableTools, allowedKeys, trace);

      const runtimeResult = await this.withTimeout(
        this.options.runtime.run({
          code: input.code,
          tools,
          timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );

      const outputResult = this.capFinalOutput(runtimeResult.output);
      trace.finalOutputTruncated = outputResult.truncated;
      trace.durationMs = Date.now() - startedAt;

      return {
        isError: false,
        output: outputResult.output,
        stdout: runtimeResult.stdout,
        stderr: runtimeResult.stderr,
        trace,
      };
    } catch (err) {
      trace.durationMs = Date.now() - startedAt;
      return {
        isError: true,
        error: err instanceof Error ? err.message : String(err),
        trace,
      };
    }
  }

  private async indexAvailableTools(): Promise<Map<string, IndexedRuntimeTool>> {
    const result = new Map<string, IndexedRuntimeTool>();

    for (const client of this.getClients()) {
      if (!client.isConnected()) continue;

      const { tools } = await client.listTools();
      const serverId = client.getServerId?.() ?? client.getSessionId?.() ?? 'unknown';

      for (const tool of tools) {
        result.set(this.keyFor(tool.name, serverId), {
          tool,
          client,
          serverId,
        });
      }
    }

    return result;
  }

  private resolveAllowedKeys(
    availableTools: Map<string, IndexedRuntimeTool>,
    requestedAllowedTools?: ProgrammaticAllowedToolInput[]
  ): Set<string> {
    const policyAllowed = this.normalizeAllowedTools(this.options.allowedTools, availableTools);
    const requestedAllowed = requestedAllowedTools
      ? this.normalizeAllowedTools(requestedAllowedTools, availableTools)
      : undefined;

    if (!policyAllowed && !requestedAllowed) {
      return new Set(availableTools.keys());
    }

    if (!policyAllowed) {
      return requestedAllowed!;
    }

    if (!requestedAllowed) {
      return policyAllowed;
    }

    return new Set([...requestedAllowed].filter((key) => policyAllowed.has(key)));
  }

  private normalizeAllowedTools(
    allowedTools: ProgrammaticAllowedToolInput[] | undefined,
    availableTools: Map<string, IndexedRuntimeTool>
  ): Set<string> | undefined {
    if (!allowedTools) return undefined;

    const keys = new Set<string>();

    for (const allowed of allowedTools) {
      const toolName = typeof allowed === 'string' ? allowed : allowed.toolName;
      const serverId = typeof allowed === 'string' ? undefined : allowed.serverId;

      if (serverId) {
        keys.add(this.keyFor(toolName, serverId));
        continue;
      }

      for (const [key, indexed] of availableTools) {
        if (indexed.tool.name === toolName) {
          keys.add(key);
        }
      }
    }

    return keys;
  }

  private createSandboxTools(
    availableTools: Map<string, IndexedRuntimeTool>,
    allowedKeys: Set<string>,
    trace: ProgrammaticRunTrace
  ): Record<string, SandboxToolCall> {
    const callCounts = {
      total: 0,
      active: 0,
    };

    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property !== 'string') return undefined;

          return async (args: Record<string, unknown> = {}) => {
            const matches = [...availableTools.entries()].filter(([, indexed]) => indexed.tool.name === property);
            const allowedMatches = matches.filter(([key]) => allowedKeys.has(key));

            if (allowedMatches.length === 0) {
              throw new Error(`Tool "${property}" is not allowed for programmatic execution.`);
            }

            if (allowedMatches.length > 1) {
              const servers = allowedMatches.map(([, indexed]) => indexed.serverId).join(', ');
              throw new Error(`Tool "${property}" is ambiguous across servers: [${servers}]. Restrict allowedTools with a serverId.`);
            }

            if (callCounts.total >= (this.options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS)) {
              throw new Error(`Programmatic tool run exceeded maxToolCalls (${this.options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS}).`);
            }

            if (callCounts.active >= (this.options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS)) {
              throw new Error(`Programmatic tool run exceeded maxParallelToolCalls (${this.options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS}).`);
            }

            const [, indexed] = allowedMatches[0]!;
            const startedAt = Date.now();
            const traceEntry: ProgrammaticToolCallTrace = {
              toolName: indexed.tool.name,
              serverId: indexed.serverId,
              startedAt: new Date(startedAt).toISOString(),
              durationMs: 0,
              ok: false,
            };

            callCounts.total++;
            callCounts.active++;

            try {
              const result = await indexed.client.callTool(indexed.tool.name, args);
              const cappedResult = this.capToolResult(result);
              traceEntry.ok = true;
              return cappedResult;
            } catch (err) {
              traceEntry.error = err instanceof Error ? err.message : String(err);
              throw err;
            } finally {
              callCounts.active--;
              traceEntry.durationMs = Date.now() - startedAt;
              trace.toolCalls.push(traceEntry);
            }
          };
        },
      }
    ) as Record<string, SandboxToolCall>;
  }

  private capToolResult(result: unknown): unknown {
    const maxBytes = this.options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
    const serialized = this.stringify(result);

    if (this.byteLength(serialized) <= maxBytes) {
      return result;
    }

    return `${serialized.slice(0, maxBytes)}\n[truncated]`;
  }

  private capFinalOutput(output: unknown): { output: unknown; truncated: boolean } {
    const maxBytes = this.options.maxFinalOutputBytes ?? DEFAULT_MAX_FINAL_OUTPUT_BYTES;
    const serialized = this.stringify(output);

    if (this.byteLength(serialized) <= maxBytes) {
      return { output, truncated: false };
    }

    return {
      output: `${serialized.slice(0, maxBytes)}\n[truncated]`,
      truncated: true,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Programmatic tool run timed out after ${timeoutMs}ms.`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private stringify(value: unknown): string {
    if (typeof value === 'string') return value;

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  private keyFor(toolName: string, serverId: string): string {
    return `${serverId}:${toolName}`;
  }

  private getClients(): ToolClient[] {
    if (Array.isArray(this.clientInput)) {
      return this.clientInput;
    }
    return this.clientInput.getClients();
  }
}

export function createRunCodeToolDefinition(): Tool {
  return {
    name: PROGRAMMATIC_TOOL_NAME,
    description:
      'Run sandboxed JavaScript that can call allowlisted MCP tools through the injected `tools` object. ' +
      'Use this for multi-step workflows, loops, parallel tool calls, filtering, aggregation, and returning compact final results. ' +
      'The sandbox has no filesystem, network, process, require, or environment access.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript function body to run. Use `await tools.tool_name({ ...args })` and `return` the final compact result.',
        },
        allowedTools: {
          type: 'array',
          description:
            'Optional per-run narrowing list of MCP tool names that the code may call. This cannot expand the runner policy.',
          items: {
            type: 'string',
          },
        },
      },
      required: ['code'],
    },
  };
}

export function isProgrammaticTool(toolName: string): boolean {
  return toolName === PROGRAMMATIC_TOOL_NAME;
}

export async function executeProgrammaticTool(
  toolName: string,
  args: Record<string, unknown>,
  runner: ProgrammaticToolRunnerLike
): Promise<ProgrammaticRunResult | null> {
  if (!isProgrammaticTool(toolName)) return null;

  const allowedTools = Array.isArray(args.allowedTools)
    ? args.allowedTools.filter((tool): tool is string => typeof tool === 'string')
    : undefined;

  return runner.runCode({
    code: String(args.code ?? ''),
    allowedTools,
  });
}

export function createPythonCodeInterpreterToolDefinition(): Tool {
  return {
    name: PYTHON_CODE_INTERPRETER_TOOL_NAME,
    description:
      'Execute Python code in an isolated code interpreter sandbox. ' +
      'Use this for data analysis, calculations, file processing, plotting, package-backed computation, and tasks that do not need MCP tool access. ' +
      'MCP tools are not available inside this Python interpreter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute in a single interpreter cell.',
        },
      },
      required: ['code'],
    },
  };
}

export async function executePythonCodeInterpreterTool(
  toolName: string,
  args: Record<string, unknown>,
  runtime: PythonCodeInterpreterRuntimeLike
): Promise<PythonCodeInterpreterRunResult | null> {
  if (toolName !== PYTHON_CODE_INTERPRETER_TOOL_NAME) return null;

  return runtime.runPython({
    code: String(args.code ?? ''),
  });
}
