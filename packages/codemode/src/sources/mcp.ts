import type { ToolSource, ToolDefinition } from "../types.js";

export interface McpLikeClient {
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getServerId?(): string | undefined;
  getServerName?(): string | undefined;
}

export interface McpLikeProvider {
  getClients(): McpLikeClient[];
}

/**
 * Wraps a single MCP-like client as a ToolSource.
 */
export function mcpSource(id: string, client: McpLikeClient, name?: string): ToolSource {
  return {
    id,
    name: name ?? client.getServerName?.() ?? client.getServerId?.() ?? id,
    listTools: () => client.listTools(),
    callTool: (toolName, args) => client.callTool(toolName, args),
  };
}

/**
 * Creates ToolSource[] from a provider that manages multiple MCP clients
 * (e.g. MultiSessionClient).
 */
export function mcpSources(provider: McpLikeProvider): ToolSource[] {
  return provider.getClients().map((client, index) =>
    mcpSource(
      client.getServerId?.() ?? `mcp_${index + 1}`,
      client,
      client.getServerName?.()
    )
  );
}
