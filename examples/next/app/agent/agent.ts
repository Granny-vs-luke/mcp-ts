import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

const { ToolRouter, ElicitationInterruptError } = await import("@mcp-ts/sdk/shared");

const INSTRUCTIONS = `
You are an expert assistant, an AI assistant that helps users with their tasks using the available MCP tools
`;

const globalForMcp = globalThis as unknown as { mcpClientMap?: Map<string, MultiSessionClient> };

export async function createMcpAgent(identity: string = process.env.NEXT_PUBLIC_MCP_IDENTITY!) {
  let client = globalForMcp.mcpClientMap?.get(identity);
  console.log("[MCP-ElicitDebug][next-agent] createMcpAgent", {
    identity,
    reusedClient: !!client,
  });

  if (!client) {
    client = new MultiSessionClient(identity, {
      onElicitationRequest: async (params) => {
        console.log("[MCP-ElicitDebug][next-agent] onElicitationRequest invoked; throwing interrupt", {
          mode: params.mode,
          message: params.message,
          hasSchema: !!params.requestedSchema,
          hasUrl: !!params.url,
        });
        throw new ElicitationInterruptError(params);
      }
    });
    try {
      await client.connect();
      console.log("[MCP-ElicitDebug][next-agent] MultiSessionClient connected", {
        clients: client.getClients().map((c) => ({
          sessionId: c.getSessionId(),
          serverId: c.getServerId(),
          serverName: c.getServerName(),
        })),
      });
      
      if (!globalForMcp.mcpClientMap) {
        globalForMcp.mcpClientMap = new Map();
      }
      globalForMcp.mcpClientMap.set(identity, client);
    } catch (error) {
      console.error("[McpAgent] Failed to connect MCP client:", error);
      // We do not cache the client if connection fails, ensuring it is retried next time
    }
  }

  const router = new ToolRouter(client, { strategy: "search", maxTools: 5 });
  const adapter = new AIAdapter(client, { toolRouter: router });
  const tools = await adapter.getTools();
  console.log("[MCP-ElicitDebug][next-agent] tools loaded", {
    toolNames: Object.keys(tools),
  });

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
