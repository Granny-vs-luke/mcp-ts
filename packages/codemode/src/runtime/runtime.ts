import type { RunOptions } from "isolated-vm";
import type { ToolRouter, ToolRouterPolicy } from "@mcp-ts/toolrouter";
import type {
  CodeModeLogEntry,
  CodeModeResult,
  CodeModeRunOptions,
  CodeModeRuntime,
  CodeModeRuntimeOptions,
  CodeModeToolCall
} from "../types.js";
import { classifyError } from "./errors.js";
import { estimateJsonBytes, resolveLimits } from "./limits.js";

export class IsolatedVmCodeModeRuntime implements CodeModeRuntime {
  constructor(private options: CodeModeRuntimeOptions) {}

  async searchTools(query: string, limit?: number) {
    return this.options.router.searchTools({ query, limit });
  }

  async run(code: string, input: unknown = {}, runOptions: CodeModeRunOptions = {}): Promise<CodeModeResult> {
    const startedAt = Date.now();
    const limits = resolveLimits({
      ...this.options.limits,
      timeoutMs: runOptions.timeoutMs ?? this.options.limits?.timeoutMs
    });
    const logs: CodeModeLogEntry[] = [];
    const toolCalls: CodeModeToolCall[] = [];
    let activeToolCalls = 0;
    let totalToolCalls = 0;

    const ivm = await loadIsolatedVm();
    const isolate = new ivm.Isolate({ memoryLimit: limits.memoryLimitMb });

    const hostCallTool = async (
      sourceId: string,
      toolName: string,
      args: Record<string, unknown> = {}
    ): Promise<unknown> => {
      if (totalToolCalls >= limits.maxToolCalls) {
        throw new Error(`Policy denied tool call: maxToolCalls ${limits.maxToolCalls} exceeded.`);
      }
      if (activeToolCalls >= limits.maxConcurrentToolCalls) {
        throw new Error(
          `Policy denied tool call: maxConcurrentToolCalls ${limits.maxConcurrentToolCalls} exceeded.`
        );
      }

      activeToolCalls += 1;
      totalToolCalls += 1;
      const callStartedAt = Date.now();
      const call: CodeModeToolCall = {
        id: `call_${totalToolCalls}`,
        sourceId,
        toolName,
        args,
        startedAt: callStartedAt,
        durationMs: 0,
        ok: false
      };
      toolCalls.push(call);

      try {
        const result = await this.options.router.callTool({
          sourceId,
          toolName,
          args
        });
        call.ok = true;
        return result;
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        call.durationMs = Date.now() - callStartedAt;
        activeToolCalls -= 1;
      }
    };

    const hostSearchTools = async (query: string, limit?: number) => {
      return this.options.router.searchTools({ query, limit });
    };

    const hostLog = (level: CodeModeLogEntry["level"], args: unknown[]) => {
      if (logs.length < limits.maxLogEntries) {
        logs.push({ level, args });
      }
    };

    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set("globalThis", jail.derefInto());
      await jail.set("__input", new ivm.ExternalCopy(input).copyInto());
      await jail.set("__hostCallTool", new ivm.Reference(hostCallTool));
      await jail.set("__hostSearchTools", new ivm.Reference(hostSearchTools));
      await jail.set("__hostLog", new ivm.Reference(hostLog));

      const bootstrap = `
        "use strict";
        const input = __input;
        const callTool = (sourceId, toolName, args = {}) =>
          __hostCallTool.apply(undefined, [sourceId, toolName, args], {
            arguments: { copy: true },
            result: { promise: true, copy: true }
          });
        const searchTools = (query, limit) =>
          __hostSearchTools.apply(undefined, [query, limit], {
            arguments: { copy: true },
            result: { promise: true, copy: true }
          });
        const console = {};
        for (const level of ["log", "info", "warn", "error"]) {
          console[level] = (...args) =>
            __hostLog.applyIgnored(undefined, [level, args], { arguments: { copy: true } });
        }
      `;
      await context.eval(bootstrap, { timeout: limits.timeoutMs });

      const wrapped = `
        (async () => {
          "use strict";
          ${code}
        })()
      `;
      const script = await isolate.compileScript(wrapped);
      const value = await script.run(context, {
        timeout: limits.timeoutMs,
        promise: true,
        copy: true
      } as RunOptions);

      if (estimateJsonBytes(value) > limits.maxResultBytes) {
        throw new Error(`Result too large: maxResultBytes ${limits.maxResultBytes} exceeded.`);
      }

      return {
        value,
        logs,
        toolCalls,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      return {
        logs,
        toolCalls,
        durationMs: Date.now() - startedAt,
        error: classifyError(error)
      };
    } finally {
      isolate.dispose();
    }
  }
}

export function createCodeModeRuntime(options: CodeModeRuntimeOptions): CodeModeRuntime {
  return new IsolatedVmCodeModeRuntime(options);
}

async function loadIsolatedVm(): Promise<typeof import("isolated-vm").default> {
  try {
    const loaded = await import("isolated-vm");
    return loaded.default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `isolated-vm is required to run codemode sandboxes but could not be loaded: ${message}`
    );
  }
}

export type { ToolRouter, ToolRouterPolicy };
