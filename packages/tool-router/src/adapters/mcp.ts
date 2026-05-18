import type { ToolDefinition, ToolServer } from "../types.js";

export interface ToolClient {
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool?(name: string, args: Record<string, unknown>): Promise<unknown>;
  tools?(): Promise<Record<string, unknown>>;
  getServerId?(): string | undefined;
  getServerName?(): string | undefined;
}

export interface ToolClientProvider {
  getClients(): ToolClient[];
}

export function mcpServer(id: string, client: ToolClient, name?: string): ToolServer {
  let cachedToolsPromise: Promise<Record<string, unknown>> | null = null;

  return {
    id,
    name: name ?? client.getServerName?.() ?? client.getServerId?.() ?? id,
    listTools: () => client.listTools(),
    callTool: async (toolName, args) => {
      if (client.callTool) {
        return client.callTool(toolName, args);
      }

      if (!client.tools) {
        throw new Error(`Client for server "${id}" does not support tool execution.`);
      }

      if (!cachedToolsPromise) {
        cachedToolsPromise = client.tools();
      }
      const toolSet = await cachedToolsPromise;
      const tool = toolSet[toolName] as { execute?: (...args: unknown[]) => Promise<unknown> } | undefined;
      if (!tool || typeof tool.execute !== "function") {
        throw new Error(`Tool "${toolName}" not found on server "${id}".`);
      }
      return tool.execute(args);
    },
    refresh: async () => {
      cachedToolsPromise = null;
    }
  };
}

export function mcpServers(provider: ToolClientProvider): ToolServer[] {
  return provider.getClients().map((client, index) =>
    mcpServer(
      client.getServerId?.() ?? `mcp_${index + 1}`,
      client,
      client.getServerName?.()
    )
  );
}

