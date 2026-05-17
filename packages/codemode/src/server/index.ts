import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodeModeRuntimeOptions } from "../types.js";
import { createCodeModeRuntime } from "../runtime/runtime.js";

export interface CodeModeMcpServerOptions extends CodeModeRuntimeOptions {
  name?: string;
  version?: string;
}

export async function createCodeModeMcpServer(options: CodeModeMcpServerOptions): Promise<McpServer> {
  const runtime = await createCodeModeRuntime(options);
  const server = new McpServer({
    name: options.name ?? "mcp-ts-codemode",
    version: options.version ?? "0.1.0"
  });

  server.registerTool(
    "codemode_search_tools",
    {
      description:
        "Search connected tool sources by natural language description. Returns tool names, source IDs, and TypeScript interfaces.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the task or tools you need."),
        limit: z.number().optional().describe("Maximum number of results (default: 10).")
      }
    },
    async ({ query, limit }) => {
      const results = await runtime.searchTools(query, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }]
      };
    }
  );

  server.registerTool(
    "codemode_list_sources",
    {
      description: "List all connected tool sources and indexed tool counts.",
      inputSchema: {}
    },
    async () => {
      const result = runtime.listSources();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.registerTool(
    "codemode_tools_info",
    {
      description:
        "Get detailed TypeScript interface definitions for specific tools. Use after search to understand exact input contracts.",
      inputSchema: {
        tool_names: z.array(z.string()).describe("Tool names in 'sourceId.toolName' format.")
      }
    },
    async ({ tool_names }) => {
      const result = runtime.getToolInterfaces(tool_names);
      return {
        content: [{ type: "text" as const, text: result }]
      };
    }
  );

  server.registerTool(
    "call_tool_chain",
    {
      description:
        "Execute TypeScript code with direct access to all registered tools as hierarchical functions (e.g., manual.tool()). " +
        "No await needed. Use return for the final value.",
      inputSchema: {
        code: z.string().describe("TypeScript code to execute with access to all registered tools."),
        input: z.any().optional().describe("Serializable input exposed as 'input' in the sandbox."),
        timeoutMs: z.number().optional().describe("Optional per-run timeout in milliseconds.")
      }
    },
    async ({ code, input, timeoutMs }) => {
      const result = await runtime.run(code, input, { timeoutMs });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: Boolean(result.error)
      };
    }
  );

  return server;
}
