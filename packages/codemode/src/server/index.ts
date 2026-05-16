import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodeModeRuntimeOptions } from "../types.js";
import { createCodeModeRuntime } from "../runtime/runtime.js";

export interface CodeModeMcpServerOptions extends CodeModeRuntimeOptions {
  name?: string;
  version?: string;
}

export function createCodeModeMcpServer(options: CodeModeMcpServerOptions): McpServer {
  const runtime = createCodeModeRuntime(options);
  const server = new McpServer({
    name: options.name ?? "mcp-ts-codemode",
    version: options.version ?? "0.1.0"
  });

  server.registerTool(
    "codemode_run",
    {
      description:
        "Run sandboxed JavaScript code that can search and call routed MCP tools through controlled helpers.",
      inputSchema: {
        code: z.string().describe("Async JavaScript body. Use return to provide the final value."),
        input: z.any().optional().describe("Serializable input exposed as `input` in the sandbox."),
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
