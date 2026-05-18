import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createToolRouter, createAISDKTools, asToolServer } from "@mcp-ts/tool-router";

// ----------------------------------------------------------------------
// 1. Agent Instructions
// ----------------------------------------------------------------------
const INSTRUCTIONS = `
You are an expert assistant that helps users with tasks using the available MCP tools.

use this flow:
1) list_servers
2) search_tools
3) get_tool_schema
4) call_tool

Always search tools first before calling them.
`;
// Exception: 'web_search_exa' is pinned and always visible, so you can call it directly without searching first!

const EXA_MCP_URL =
  "https://mcp.exa.ai/mcp?tools=web_search_exa,deep_search_exa,get_code_context_exa,crawling_exa";
const GREP_MCP_URL = "https://mcp.grep.app";

const globalForMcp = globalThis as unknown as {
  toolRouterToolsPromise?: Promise<Record<string, unknown>>;
};

async function getRouterTools(): Promise<Record<string, unknown>> {
  if (!globalForMcp.toolRouterToolsPromise) {
    globalForMcp.toolRouterToolsPromise = (async () => {
      const [exaClient, grepClient] = await Promise.all([
        createMCPClient({
          transport: { type: "http", url: EXA_MCP_URL }
        }),
        createMCPClient({
          transport: { type: "http", url: GREP_MCP_URL }
        })
      ]);

      const router = await createToolRouter({
        servers: [
          asToolServer("exa", exaClient),
          asToolServer("grep", grepClient)
        ],
        // pinnedTools: ["web_search_exa"],
        maxSearchResults: 8
      });

      return createAISDKTools(router) as Promise<Record<string, unknown>>;
    })();
  }

  return globalForMcp.toolRouterToolsPromise;
}

export async function createMcpAgent(userId: string = process.env.NEXT_PUBLIC_MCP_USER_ID!) {
  void userId;
  const tools = await getRouterTools();

  return new ToolLoopAgent({
    model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-chat"),
    instructions: INSTRUCTIONS,
    tools: tools as any,
    stopWhen: stepCountIs(20),
  });
}

export type McpAgentUIMessage = InferAgentUIMessage<
  Awaited<ReturnType<typeof createMcpAgent>>
>;
