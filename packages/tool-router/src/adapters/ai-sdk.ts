import type { ToolRouter } from "../router.js";
import type { ToolSource } from "../types.js";

export type AISDKToolSet = Record<string, {
  description?: string;
  inputSchema: unknown;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  annotations?: any;
}>;

export interface MCPClient {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
  }>;
  tools(): Promise<Record<string, unknown>>;
}

export function asToolSource(id: string, client: MCPClient, name?: string): ToolSource {
  let cachedToolsPromise: Promise<Record<string, unknown>> | null = null;

  return {
    id,
    name: name ?? id,
    listTools: async () => {
      const result = await client.listTools();
      return {
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : undefined,
          inputSchema: tool.inputSchema,
          annotations: (tool.annotations ?? undefined) as Record<string, unknown> | undefined
        }))
      };
    },
    callTool: async (toolName, args) => {
      if (!cachedToolsPromise) {
        cachedToolsPromise = client.tools();
      }
      const toolSet = await cachedToolsPromise;
      const tool = toolSet[toolName] as { execute?: (...args: unknown[]) => Promise<unknown> } | undefined;
      if (!tool || typeof tool.execute !== "function") {
        throw new Error(`Tool "${toolName}" not found on source "${id}".`);
      }
      return tool.execute(args);
    },
    refresh: async () => {
      cachedToolsPromise = null;
    }
  };
}

export async function createAISDKTools(router: ToolRouter): Promise<AISDKToolSet> {
  let jsonSchema: ((schema: any) => unknown) | undefined;
  try {
    ({ jsonSchema } = await import("ai"));
  } catch {
    jsonSchema = (schema: unknown) => schema;
  }

  return Object.fromEntries(
    router.getMetaTools().map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema!(tool.inputSchema),
        annotations: tool.annotations,
        execute: async (args: Record<string, unknown>) => router.executeMetaTool(tool.name, args)
      }
    ])
  );
}
