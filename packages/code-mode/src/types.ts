// ---------------------------------------------------------------------------
// Tool Source & Definition types (owned by codemode — no toolrouter dependency)
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  [key: string]: unknown;
}

export interface ToolSource {
  id: string;
  name?: string;
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface IndexedTool {
  sourceId: string;
  sourceName: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ToolSearchResult {
  sourceId: string;
  sourceName: string;
  toolName: string;
  description: string;
  annotations?: ToolAnnotations;
  score: number;
}

// ---------------------------------------------------------------------------
// Codemode Runtime types
// ---------------------------------------------------------------------------

export interface CodeModeLimits {
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxToolCalls?: number;
  maxConcurrentToolCalls?: number;
  maxResultBytes?: number;
  maxLogEntries?: number;
}

export interface CodeModeRuntimeOptions {
  sources: ToolSource[];
  limits?: CodeModeLimits;
  maxSearchResults?: number;
}

export interface CodeModeRunOptions {
  timeoutMs?: number;
}

export interface CodeModeLogEntry {
  level: "log" | "info" | "warn" | "error";
  args: unknown[];
}

export interface CodeModeToolCall {
  id: string;
  sourceId: string;
  toolName: string;
  args: unknown;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface CodeModeError {
  code:
    | "SANDBOX_ERROR"
    | "TIMEOUT"
    | "TOOL_NOT_FOUND"
    | "TOOL_EXECUTION_FAILED"
    | "RESULT_TOO_LARGE";
  message: string;
}

export interface CodeModeResult {
  value?: unknown;
  logs: CodeModeLogEntry[];
  toolCalls: CodeModeToolCall[];
  durationMs: number;
  error?: CodeModeError;
}

export interface CodeModeRuntime {
  run(code: string, input?: unknown, options?: CodeModeRunOptions): Promise<CodeModeResult>;
  searchTools(query: string, limit?: number): Promise<ToolSearchResult[]>;
  listSources(): Array<{ sourceId: string; sourceName: string; toolCount: number }>;
  getToolInterfaces(toolNames: string[]): string;
}
