import type { ToolRouter, ToolRouterPolicy, ToolSearchResult } from "@mcp-ts/toolrouter";

export interface CodeModeLimits {
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxToolCalls?: number;
  maxConcurrentToolCalls?: number;
  maxResultBytes?: number;
  maxLogEntries?: number;
}

export interface CodeModeRuntimeOptions {
  router: ToolRouter;
  limits?: CodeModeLimits;
  policy?: ToolRouterPolicy;
}

export interface CodeModeRunOptions {
  timeoutMs?: number;
  toolPolicy?: ToolRouterPolicy;
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
    | "POLICY_DENIED"
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
}
