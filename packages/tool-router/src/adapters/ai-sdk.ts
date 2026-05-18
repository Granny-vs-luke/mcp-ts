import type { ToolRouter } from "../router.js";

export type AISDKToolSet = Record<string, {
  description?: string;
  inputSchema: unknown;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  annotations?: any;
}>;

export async function createAISDKTools(router: ToolRouter): Promise<AISDKToolSet> {
  let jsonSchema: ((schema: any) => unknown) | undefined;
  try {
    ({ jsonSchema } = await import("ai"));
  } catch {
    jsonSchema = (schema: unknown) => schema;
  }

  await router.initialize();
  const { pinned, metaTools } = router.getVisibleTools();

  const pinnedEntries = pinned.map((tool) => [
    tool.toolName,
    {
      description: tool.description,
      inputSchema: jsonSchema!(tool.inputSchema ?? { type: "object" }),
      annotations: tool.annotations,
      execute: async (args: Record<string, unknown>) =>
        router.callTool({ toolId: tool.toolId, args })
    }
  ]);

  const metaEntries = metaTools.map((tool) => [
    tool.name,
    {
      description: tool.description,
      inputSchema: jsonSchema!(tool.inputSchema),
      annotations: tool.annotations,
      execute: async (args: Record<string, unknown>) => router.executeMetaTool(tool.name, args)
    }
  ]);

  return Object.fromEntries([...pinnedEntries, ...metaEntries]);
}
