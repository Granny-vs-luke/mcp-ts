import type {
  ProgrammaticAllowedToolInput,
  ProgrammaticToolClientInput,
} from '../../shared/programmatic-tool-runner.js';
import type { ToolClient, ToolClientProvider } from '../../shared/types.js';

export interface ProgrammaticToolBridgeOptions {
  allowedTools?: ProgrammaticAllowedToolInput[];
  bridgeToken?: string;
  maxToolResultBytes?: number;
}

export interface ProgrammaticToolBridgeRequest {
  toolName: string;
  args?: Record<string, unknown>;
  serverId?: string;
}

interface IndexedBridgeTool {
  client: ToolClient;
  toolName: string;
  serverId: string;
}

const DEFAULT_MAX_TOOL_RESULT_BYTES = 200_000;

export class ProgrammaticToolBridge {
  constructor(
    private clientInput: ProgrammaticToolClientInput,
    private options: ProgrammaticToolBridgeOptions = {}
  ) {}

  async handleRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return this.json({ isError: true, error: 'Programmatic tool bridge only accepts POST requests.' }, 405);
    }

    if (this.options.bridgeToken) {
      const expected = `Bearer ${this.options.bridgeToken}`;
      if (request.headers.get('authorization') !== expected) {
        return this.json({ isError: true, error: 'Invalid programmatic tool bridge token.' }, 401);
      }
    }

    try {
      const body = (await request.json()) as ProgrammaticToolBridgeRequest;
      const result = await this.execute(body);
      return this.json({ result }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('not allowed') ? 403 : 400;
      return this.json({ isError: true, error: message }, status);
    }
  }

  async execute(input: ProgrammaticToolBridgeRequest): Promise<unknown> {
    const toolName = String(input.toolName ?? '');
    if (!toolName) {
      throw new Error('Missing required field "toolName".');
    }

    const tools = await this.indexTools();
    const allowedKeys = this.resolveAllowedKeys(tools);
    const matches = [...tools.entries()].filter(([, tool]) => tool.toolName === toolName);
    const allowedMatches = matches.filter(([key, tool]) => {
      return allowedKeys.has(key) && (!input.serverId || tool.serverId === input.serverId);
    });

    if (allowedMatches.length === 0) {
      throw new Error(`Tool "${toolName}" is not allowed for programmatic execution.`);
    }

    if (allowedMatches.length > 1) {
      const servers = allowedMatches.map(([, tool]) => tool.serverId).join(', ');
      throw new Error(`Tool "${toolName}" is ambiguous across servers: [${servers}]. Pass serverId.`);
    }

    const [, indexed] = allowedMatches[0]!;
    const result = await indexed.client.callTool(indexed.toolName, input.args ?? {});
    return this.capResult(result);
  }

  private async indexTools(): Promise<Map<string, IndexedBridgeTool>> {
    const result = new Map<string, IndexedBridgeTool>();

    for (const client of this.getClients()) {
      if (!client.isConnected()) continue;

      const { tools } = await client.listTools();
      const serverId = client.getServerId?.() ?? client.getSessionId?.() ?? 'unknown';

      for (const tool of tools) {
        result.set(this.keyFor(tool.name, serverId), {
          client,
          toolName: tool.name,
          serverId,
        });
      }
    }

    return result;
  }

  private resolveAllowedKeys(tools: Map<string, IndexedBridgeTool>): Set<string> {
    if (!this.options.allowedTools) {
      return new Set(tools.keys());
    }

    const allowed = new Set<string>();

    for (const entry of this.options.allowedTools) {
      const toolName = typeof entry === 'string' ? entry : entry.toolName;
      const serverId = typeof entry === 'string' ? undefined : entry.serverId;

      for (const [key, tool] of tools) {
        if (tool.toolName === toolName && (!serverId || tool.serverId === serverId)) {
          allowed.add(key);
        }
      }
    }

    return allowed;
  }

  private capResult(result: unknown): unknown {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result);
    const maxBytes = this.options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;

    if (new TextEncoder().encode(serialized).length <= maxBytes) {
      return result;
    }

    return `${serialized.slice(0, maxBytes)}\n[truncated]`;
  }

  private json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private keyFor(toolName: string, serverId: string): string {
    return `${serverId}:${toolName}`;
  }

  private getClients(): ToolClient[] {
    if (Array.isArray(this.clientInput)) {
      return this.clientInput;
    }

    return (this.clientInput as ToolClientProvider).getClients();
  }
}

