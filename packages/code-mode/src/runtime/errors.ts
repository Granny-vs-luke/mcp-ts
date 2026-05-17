import type { CodeModeError } from "../types.js";

export function classifyError(error: unknown): CodeModeError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }
  if (lower.includes("policy denied")) {
    return { code: "POLICY_DENIED", message };
  }
  if (lower.includes("was not found") || lower.includes("tool not found")) {
    return { code: "TOOL_NOT_FOUND", message };
  }
  if (lower.includes("result too large")) {
    return { code: "RESULT_TOO_LARGE", message };
  }
  if (lower.includes("tool execution")) {
    return { code: "TOOL_EXECUTION_FAILED", message };
  }

  return { code: "SANDBOX_ERROR", message };
}
