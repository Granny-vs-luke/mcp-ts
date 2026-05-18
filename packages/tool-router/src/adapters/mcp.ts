import type { ToolDefinition, ToolServer } from "../types.js";

export interface McpLikeClient {
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getServerId?(): string | undefined;
  getServerName?(): string | undefined;
}

export interface McpLikeProvider {
  getClients(): McpLikeClient[];
}

export function mcpServer(id: string, client: McpLikeClient, name?: string): ToolServer {
  return {
    id,
    name: name ?? client.getServerName?.() ?? client.getServerId?.() ?? id,
    listTools: () => client.listTools(),
    callTool: (toolName, args) => client.callTool(toolName, args)
  };
}

export function mcpServers(provider: McpLikeProvider): ToolServer[] {
  return provider.getClients().map((client, index) =>
    mcpServer(
      client.getServerId?.() ?? `mcp_${index + 1}`,
      client,
      client.getServerName?.()
    )
  );
}

