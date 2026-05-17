import type { CodeModeRuntime } from "../types.js";

export type AISDKToolSet = Record<string, {
  description?: string;
  inputSchema: unknown;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}>;

/**
 * Creates AI SDK compatible tools from a CodeModeRuntime.
 * Returns a tool set with discovery, introspection, and execution tools.
 * The LLM only sees these tools — no direct tool execution path.
 */
export async function createCodemodeAITools(runtime: CodeModeRuntime): Promise<AISDKToolSet> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jsonSchema: (schema: any) => any;
  try {
    const ai = await import("ai");
    jsonSchema = ai.jsonSchema;
  } catch {
    jsonSchema = (schema: unknown) => schema;
  }

  return {
    codemode_search_tools: {
      description:
        "Search connected tool sources by natural language description. Returns tool names, source IDs, and TypeScript interfaces. Use this first to discover what tools are available.",
      inputSchema: jsonSchema!({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language description of the task or tools you need.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 10).",
          },
        },
        required: ["query"],
      }),
      execute: async (args: Record<string, unknown>) => {
        const query = String(args.query ?? "");
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const results = await runtime.searchTools(query, limit);
        return results;
      },
    },

    codemode_list_sources: {
      description: "List all connected tool sources and indexed tool counts.",
      inputSchema: jsonSchema!({
        type: "object",
        properties: {},
      }),
      execute: async () => {
        return runtime.listSources();
      },
    },

    codemode_tools_info: {
      description:
        "Get detailed TypeScript interface definitions for specific tools. Pass tool names as 'sourceId.toolName' format. Use after search to understand exact input/output contracts.",
      inputSchema: jsonSchema!({
        type: "object",
        properties: {
          tool_names: {
            type: "array",
            items: { type: "string" },
            description:
              "Tool names to get interfaces for, in 'sourceId.toolName' format (e.g. ['github.get_issue', 'exa.web_search']).",
          },
        },
        required: ["tool_names"],
      }),
      execute: async (args: Record<string, unknown>) => {
        const toolNames = (args.tool_names ?? []) as string[];
        return runtime.getToolInterfaces(toolNames);
      },
    },

    call_tool_chain: {
      description:
        "Execute TypeScript code with direct access to all registered tools as hierarchical functions (e.g., manual.tool()). " +
        "Tool calls are synchronous from the sandbox — no 'await' needed (but 'await' also works). " +
        "Use 'return' to provide the final value. Console output is captured. " +
        "Also available: callTool(sourceId, toolName, args), searchTools(query), __interfaces, __getToolInterface(name).",
      inputSchema: jsonSchema!({
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "TypeScript code to execute with access to all registered tools. Your code runs as an async function body. " +
              "Call tools directly: source.tool(args). Use return for the final value.",
          },
          input: {
            description: "Optional serializable input exposed as 'input' in the sandbox.",
          },
          timeoutMs: {
            type: "number",
            description: "Optional per-run timeout in milliseconds.",
          },
        },
        required: ["code"],
      }),
      execute: async (args: Record<string, unknown>) => {
        const code = String(args.code ?? "");
        const input = args.input;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        const result = await runtime.run(code, input, { timeoutMs });
        if (result.error) {
          throw new Error(`Codemode failed: ${result.error.message}`);
        }
        return {
          value: result.value,
          logs: result.logs,
          toolCalls: result.toolCalls.map((c) => ({
            sourceId: c.sourceId,
            toolName: c.toolName,
            ok: c.ok,
            durationMs: c.durationMs,
            error: c.error,
          })),
          durationMs: result.durationMs,
        };
      },
    },
  };
}
