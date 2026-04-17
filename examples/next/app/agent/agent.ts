import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

const { ToolRouter } = await import("@mcp-ts/sdk/shared");

const INSTRUCTIONS = `
You are an expert assistant, an AI assistant that helps users with their tasks using the available MCP tools
`;

export async function createMcpAgent(identity: string = "demo-user-123") {
  const client = new MultiSessionClient(identity);

  try {
    await client.connect();
  } catch (error) {
    console.error("[MCP] Connection failed:", error);
  }

  const router = new ToolRouter(client, { strategy: "search" });
  const adapter = new AIAdapter(client, { toolRouter: router });
  const tools = await adapter.getTools();
  console.log(`[MCP] Loaded ${Object.keys(tools).length} tools for agent.`);

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
