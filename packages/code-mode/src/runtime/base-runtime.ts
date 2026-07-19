import type {
  CodeModeLimits,
  CodeModeLogEntry,
  CodeModeResult,
  CodeModeRunOptions,
  CodeModeRuntime,
  CodeModeRuntimeOptions,
  CodeModeToolCall,
  IndexedTool,
  ToolSearchResult,
  ToolServer,
} from "../types.js";
import { CodemodeError, classifyError } from "./errors.js";
import { estimateJsonBytes, resolveLimits } from "./limits.js";
import {
  indexServers,
  listServersFromIndex,
  normalizeServerId,
  resolveTool,
  searchToolIndex,
} from "./tool-index.js";
import {
  generateAllInterfaces,
  generateInterfaceMap,
  generateBootstrapCode,
  generateNamespaceBridgeCode,
  toolToTypeScriptInterface,
} from "./sandbox-bridge.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractToolErrorText(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (typeof content === "string") {
    return content.replace(/^Error:\s*/i, "");
  }
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    if (isRecord(first) && typeof first.text === "string") return first.text.replace(/^Error:\s*/i, "");
    if (typeof first === "string") return first.replace(/^Error:\s*/i, "");
    return JSON.stringify(first);
  }
  if (isRecord(content)) {
    const maybeError = (content as Record<string, unknown>).error ?? (content as Record<string, unknown>).message;
    if (typeof maybeError === "string") return maybeError;
    return JSON.stringify(content);
  }
  return undefined;
}

export abstract class BaseCodeModeRuntime implements CodeModeRuntime {
  protected servers: Map<string, ToolServer>;
  protected indexedTools: IndexedTool[] = [];
  protected initialized = false;
  protected maxSearchResults: number;

  constructor(protected options: CodeModeRuntimeOptions) {
    this.maxSearchResults = options.maxSearchResults ?? 10;
    this.servers = new Map<string, ToolServer>();
    for (const server of options.servers) {
      this.servers.set(normalizeServerId(server.serverId), server);
    }
  }

  protected async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.indexedTools = await indexServers(this.options.servers);
      this.initialized = true;
    }
  }

  async searchTools(query: string, limit?: number): Promise<ToolSearchResult[]> {
    await this.ensureInitialized();
    return searchToolIndex(this.indexedTools, query, limit ?? this.maxSearchResults);
  }

  listServers(): Array<{ serverId: string; serverName: string; toolCount: number }> {
    return listServersFromIndex(this.indexedTools);
  }

  getToolInterfaces(toolNames: string[]): string {
    const interfaces: string[] = [];
    const notFound: string[] = [];

    for (const name of toolNames) {
      let tool: IndexedTool | undefined;
      if (name.includes(".")) {
        const [serverId, ...rest] = name.split(".");
        const toolName = rest.join(".");
        tool = resolveTool(this.indexedTools, toolName, serverId);
      } else {
        tool = resolveTool(this.indexedTools, name);
      }

      if (tool) {
        interfaces.push(toolToTypeScriptInterface(tool));
      } else {
        notFound.push(`// Tool '${name}' not found`);
      }
    }

    if (interfaces.length === 0 && notFound.length > 0) {
      return notFound.join("\n");
    }
    let result = interfaces.join("\n\n");
    if (notFound.length > 0) {
      result += "\n\n" + notFound.join("\n");
    }
    return result;
  }

  abstract run(
    code: string,
    input?: unknown,
    options?: CodeModeRunOptions,
  ): Promise<CodeModeResult>;

  protected async hostCallTool(
    serverId: string,
    toolName: string,
    argsJson: string,
    toolCalls: CodeModeToolCall[],
    activeToolCallsRef: { value: number },
    totalToolCallsRef: { value: number },
    limits: Required<CodeModeLimits>,
  ): Promise<string> {
    if (totalToolCallsRef.value >= limits.maxToolCalls) {
      return JSON.stringify({ success: true, result: { error: `maxToolCalls ${limits.maxToolCalls} exceeded.`, isError: true } });
    }
    if (activeToolCallsRef.value >= limits.maxConcurrentToolCalls) {
      return JSON.stringify({ success: true, result: { error: `maxConcurrentToolCalls ${limits.maxConcurrentToolCalls} exceeded.`, isError: true } });
    }

    activeToolCallsRef.value += 1;
    totalToolCallsRef.value += 1;
    const callStartedAt = Date.now();
    const call: CodeModeToolCall = {
      id: `call_${totalToolCallsRef.value}`,
      serverId,
      toolName,
      args: null as unknown as Record<string, unknown>,
      startedAt: callStartedAt,
      durationMs: 0,
      ok: false,
    };
    toolCalls.push(call);

    try {
      const args = JSON.parse(argsJson);
      call.args = args;

      let server = this.servers.get(normalizeServerId(serverId));
      if (!server) {
        const tool = resolveTool(this.indexedTools, toolName, serverId);
        if (!tool) throw new Error(`Tool "${toolName}" was not found on server "${serverId}".`);
        server = this.servers.get(tool.serverId);
        if (!server) throw new Error(`Server "${tool.serverId}" is no longer registered.`);
      }

      const result = await server.callTool(toolName, args);
      if (isRecord(result) && result.isError === true) {
        call.ok = false;
        call.error = extractToolErrorText(result) || "MCP tool returned an error";
      } else {
        call.ok = true;
      }
      return JSON.stringify({ success: true, result });
    } catch (error) {
      call.ok = false;
      call.error = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: true, result: { error: call.error, isError: true } });
    } finally {
      call.durationMs = Date.now() - callStartedAt;
      activeToolCallsRef.value -= 1;
    }
  }

  protected hostSearchTools(query: string, limit: number): string {
    const results = searchToolIndex(this.indexedTools, query, limit);
    return JSON.stringify(results);
  }

  protected hostGetToolSchema(serverId: string, toolName: string): string {
    const tool = resolveTool(this.indexedTools, toolName, serverId);
    if (!tool) {
      return JSON.stringify({ error: `Tool "${toolName}" not found on server "${serverId}".` });
    }
    return JSON.stringify(tool);
  }

  protected hostLog(
    level: CodeModeLogEntry["level"],
    args: unknown[],
    logs: CodeModeLogEntry[],
    limits: Required<CodeModeLimits>,
  ): void {
    if (logs.length < limits.maxLogEntries) {
      logs.push({ level, args });
    }
  }
}
