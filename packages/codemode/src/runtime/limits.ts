import type { CodeModeLimits } from "../types.js";

export const DEFAULT_LIMITS: Required<CodeModeLimits> = {
  timeoutMs: 10_000,
  memoryLimitMb: 64,
  maxToolCalls: 20,
  maxConcurrentToolCalls: 3,
  maxResultBytes: 1024 * 1024,
  maxLogEntries: 100
};

export function resolveLimits(limits: CodeModeLimits | undefined): Required<CodeModeLimits> {
  return { ...DEFAULT_LIMITS, ...limits };
}

export function estimateJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
