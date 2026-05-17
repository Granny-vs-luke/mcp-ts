import type { ToolRouter } from "../router.js";
import { isToolRouterMetaTool } from "../meta-tools.js";

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

  return Object.fromEntries(
    router.getMetaTools().map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema!(tool.inputSchema),
        annotations: tool.annotations,
        execute: async (args: Record<string, unknown>) => {
          if (!isToolRouterMetaTool(tool.name)) {
            throw new Error(`Unknown toolrouter meta tool "${tool.name}".`);
          }
          return router.executeMetaTool(tool.name, args);
        }
      }
    ])
  );
}
