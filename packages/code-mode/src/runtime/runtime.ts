import type {
  CodeModeLogEntry,
  CodeModeResult,
  CodeModeRunOptions,
  CodeModeRuntime,
  CodeModeRuntimeOptions,
  CodeModeToolCall,
  IndexedTool,
  ToolSearchResult,
  ToolSource,
} from "../types.js";
import { classifyError } from "./errors.js";
import { estimateJsonBytes, resolveLimits } from "./limits.js";
import {
  indexSources,
  listSourcesFromIndex,
  normalizeSourceId,
  resolveTool,
  searchToolIndex,
} from "./tool-index.js";
import {
  generateAllInterfaces,
  generateBootstrapCode,
  generateInterfaceMap,
  generateNamespaceBridgeCode,
  toolToTypeScriptInterface,
} from "./sandbox-bridge.js";

export class IsolatedVmCodeModeRuntime implements CodeModeRuntime {
  private sources: Map<string, ToolSource>;
  private indexedTools: IndexedTool[] = [];
  private initialized = false;
  private maxSearchResults: number;

  constructor(private options: CodeModeRuntimeOptions) {
    this.maxSearchResults = options.maxSearchResults ?? 10;
    this.sources = new Map<string, ToolSource>();
    for (const source of options.sources) {
      this.sources.set(normalizeSourceId(source.id), source);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.indexedTools = await indexSources(this.options.sources);
      this.initialized = true;
    }
  }

  async searchTools(query: string, limit?: number): Promise<ToolSearchResult[]> {
    await this.ensureInitialized();
    return searchToolIndex(this.indexedTools, query, limit ?? this.maxSearchResults);
  }

  listSources(): Array<{ sourceId: string; sourceName: string; toolCount: number }> {
    return listSourcesFromIndex(this.indexedTools);
  }

  getToolInterfaces(toolNames: string[]): string {
    const interfaces: string[] = [];
    const notFound: string[] = [];

    for (const name of toolNames) {
      // name can be "sourceId.toolName" or just "toolName"
      let tool: IndexedTool | undefined;
      if (name.includes(".")) {
        const [sourceId, ...rest] = name.split(".");
        const toolName = rest.join(".");
        tool = resolveTool(this.indexedTools, toolName, sourceId);
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

  async run(
    code: string,
    input: unknown = {},
    runOptions: CodeModeRunOptions = {},
  ): Promise<CodeModeResult> {
    await this.ensureInitialized();

    const startedAt = Date.now();
    const limits = resolveLimits({
      ...this.options.limits,
      timeoutMs: runOptions.timeoutMs ?? this.options.limits?.timeoutMs,
    });
    const logs: CodeModeLogEntry[] = [];
    const toolCalls: CodeModeToolCall[] = [];
    let activeToolCalls = 0;
    let totalToolCalls = 0;

    const ivm = await loadIsolatedVm();
    const isolate = new ivm.Isolate({ memoryLimit: limits.memoryLimitMb });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    // -----------------------------------------------------------------------
    // Host-side callbacks
    // -----------------------------------------------------------------------

    const hostCallTool = async (
      sourceId: string,
      toolName: string,
      argsJson: string,
    ): Promise<string> => {
      if (totalToolCalls >= limits.maxToolCalls) {
        return JSON.stringify({ success: false, error: `maxToolCalls ${limits.maxToolCalls} exceeded.` });
      }
      if (activeToolCalls >= limits.maxConcurrentToolCalls) {
        return JSON.stringify({
          success: false,
          error: `maxConcurrentToolCalls ${limits.maxConcurrentToolCalls} exceeded.`,
        });
      }

      activeToolCalls += 1;
      totalToolCalls += 1;
      const callStartedAt = Date.now();
      const call: CodeModeToolCall = {
        id: `call_${totalToolCalls}`,
        sourceId,
        toolName,
        args: JSON.parse(argsJson),
        startedAt: callStartedAt,
        durationMs: 0,
        ok: false,
      };
      toolCalls.push(call);

      try {
        const tool = resolveTool(this.indexedTools, toolName, sourceId);
        if (!tool) {
          throw new Error(`Tool "${toolName}" was not found on source "${sourceId}".`);
        }

        const source = this.sources.get(tool.sourceId);
        if (!source) {
          throw new Error(`Source "${tool.sourceId}" is no longer registered.`);
        }

        const result = await source.callTool(toolName, JSON.parse(argsJson));
        call.ok = true;
        return JSON.stringify({ success: true, result });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        call.error = errorMsg;
        return JSON.stringify({ success: false, error: errorMsg });
      } finally {
        call.durationMs = Date.now() - callStartedAt;
        activeToolCalls -= 1;
      }
    };

    const hostSearchTools = async (query: string, limit: number): Promise<string> => {
      const results = searchToolIndex(this.indexedTools, query, limit);
      return JSON.stringify(results);
    };

    const hostGetToolSchema = async (sourceId: string, toolName: string): Promise<string> => {
      const tool = resolveTool(this.indexedTools, toolName, sourceId);
      if (!tool) {
        return JSON.stringify({ error: `Tool "${toolName}" not found on source "${sourceId}".` });
      }
      return JSON.stringify(tool);
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

      // Input
      await jail.set("__input", new ivm.ExternalCopy(input).copyInto());

      // Log handlers
      const createLogHandler = (prefix: string) => {
        return new ivm.Reference((...args: unknown[]) => {
          const message = (args as string[]).join(" ");
          hostLog(
            (prefix === "" ? "log" : prefix === "[ERROR]" ? "error" : prefix === "[WARN]" ? "warn" : "info") as CodeModeLogEntry["level"],
            [message],
          );
        });
      };
      await jail.set("__logRef", createLogHandler(""));
      await jail.set("__errorRef", createLogHandler("[ERROR]"));
      await jail.set("__warnRef", createLogHandler("[WARN]"));
      await jail.set("__infoRef", createLogHandler("[INFO]"));

      // Tool call reference (async, returns JSON string)
      const toolCallerRef = new ivm.Reference(hostCallTool);
      await jail.set("__callToolRef", toolCallerRef);

      // Search tools reference
      const searchRef = new ivm.Reference(hostSearchTools);
      await jail.set("__searchToolsRef", searchRef);

      // Get tool schema reference
      const schemaRef = new ivm.Reference(hostGetToolSchema);
      await jail.set("__getToolSchemaRef", schemaRef);

      // Generate interfaces
      const interfacesString = generateAllInterfaces(this.indexedTools);
      const interfaceMap = generateInterfaceMap(this.indexedTools);
      const interfaceMapJson = JSON.stringify(interfaceMap);

      // Bootstrap: console, callTool, searchTools, interfaces
      const bootstrapCode = generateBootstrapCode(interfacesString, interfaceMapJson);
      const bootstrapScript = await isolate.compileScript(bootstrapCode);
      await bootstrapScript.run(context);

      // Namespace bridging: source.tool(args) functions
      const namespaceBridgeCode = generateNamespaceBridgeCode(this.indexedTools, this.sources);
      if (namespaceBridgeCode.trim()) {
        const namespaceScript = await isolate.compileScript(namespaceBridgeCode);
        await namespaceScript.run(context);
      }

      // User code execution using UTCP's async IIFE + callback pattern
      let resolveResult!: (json: string) => void;
      let rejectResult!: (err: Error) => void;
      const resultPromise = new Promise<string>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });

      await jail.set(
        "__resolveResult",
        new ivm.Reference((jsonStr: string) => resolveResult(jsonStr)),
      );
      await jail.set(
        "__rejectResult",
        new ivm.Reference((errStr: string) => rejectResult(new Error(errStr))),
      );

      const wrappedCode = `
        (async function() {
          try {
            const __result = await (async function() {
              ${code}
            })();
            __resolveResult.applySync(undefined, [JSON.stringify({ __result: __result === undefined ? null : __result })]);
          } catch (e) {
            __rejectResult.applySync(undefined, [String(e && e.stack ? e.stack : e)]);
          }
        })()
      `;

      // Set up timeout race
      const timeoutPromise = new Promise<string>((_, rej) => {
        timeoutHandle = setTimeout(
          () => rej(new Error(`Script execution timeout after ${limits.timeoutMs}ms`)),
          limits.timeoutMs,
        );
      });
      const settledPromise = Promise.race([resultPromise, timeoutPromise]);
      resultPromise.catch(() => {});
      timeoutPromise.catch(() => {});

      const script = await isolate.compileScript(wrappedCode);
      script.run(context, { timeout: limits.timeoutMs }).catch(() => {});

      const resultJson = await settledPromise;
      const value = JSON.parse(resultJson).__result;

      if (estimateJsonBytes(value) > limits.maxResultBytes) {
        throw new Error(`Result too large: maxResultBytes ${limits.maxResultBytes} exceeded.`);
      }

      return {
        value,
        logs,
        toolCalls,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        logs,
        toolCalls,
        durationMs: Date.now() - startedAt,
        error: classifyError(error),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      isolate.dispose();
    }
  }
}

export async function createCodeModeRuntime(
  options: CodeModeRuntimeOptions,
): Promise<CodeModeRuntime> {
  const runtime = new IsolatedVmCodeModeRuntime(options);
  // Eagerly initialize tool index
  await runtime.searchTools("", 1);
  return runtime;
}

async function loadIsolatedVm(): Promise<typeof import("isolated-vm").default> {
  try {
    const loaded = await import("isolated-vm");
    return loaded.default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `isolated-vm is required to run codemode sandboxes but could not be loaded: ${message}`,
    );
  }
}
