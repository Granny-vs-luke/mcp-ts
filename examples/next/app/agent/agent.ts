import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

const { ToolRouter } = await import("@mcp-ts/sdk/shared");

const INSTRUCTIONS = `
You are an expert assistant, an AI assistant that helps users with their tasks using the available MCP tools.

IMPORTANT: When a tool requires user approval, explain what you intend to do and why before calling it.
If the user denies a tool call, acknowledge their decision and suggest alternatives.
`;

const globalForMcp = globalThis as unknown as { mcpClientMap?: Map<string, MultiSessionClient> };

export async function createMcpAgent(identity: string = process.env.NEXT_PUBLIC_MCP_IDENTITY!) {
  let client = globalForMcp.mcpClientMap?.get(identity);

  if (!client) {
    client = new MultiSessionClient(identity);
    if (!globalForMcp.mcpClientMap) {
      globalForMcp.mcpClientMap = new Map();
    }
    globalForMcp.mcpClientMap.set(identity, client);
  }

  // Always call connect to synchronize with the database.
  // MultiSessionClient safely skips already-connected sessions and only connects to newly added ones.
  try {
    await client.connect();
  } catch (error) {
    console.error("[McpAgent] Failed to connect MCP client:", error);
  }

  const router = new ToolRouter(client, { strategy: "search", maxTools: 5 });
  const adapter = new AIAdapter(client, { toolRouter: router });
  const tools = await adapter.getTools();

  return new ToolLoopAgent({
    model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(
      "deepseek-chat",
    ),
    instructions: INSTRUCTIONS,
    tools: tools as any,
    stopWhen: stepCountIs(20),
  });
}

export type McpAgentUIMessage = InferAgentUIMessage<
  Awaited<ReturnType<typeof createMcpAgent>>
>;
