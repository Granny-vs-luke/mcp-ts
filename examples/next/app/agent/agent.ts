import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createToolRouter, mcpSources, createAISDKTools } from "@mcp-ts/toolrouter";
import { createCodeModeRuntime } from "@mcp-ts/codemode";
import { z } from "zod";

// ----------------------------------------------------------------------
// 1. Agent Instructions
// ----------------------------------------------------------------------
const INSTRUCTIONS = `
You are an expert assistant, an AI assistant that helps users with their tasks using the available MCP tools.

You have access to a tool catalog. Instead of seeing all tools at once, you can:
1. Search for tools using 'toolrouter_search_tools'.
2. Fetch the schema for a tool using 'toolrouter_get_tool_schema'.
3. Call a tool using 'toolrouter_call_tool'.
4. Run complex multi-step JavaScript programs using 'codemode_run' when you need to combine results from multiple tools, loop, or transform data.

IMPORTANT: When a tool requires user approval, explain what you intend to do and why before calling it.
If the user denies a tool call, acknowledge their decision and suggest alternatives.
`;

// ----------------------------------------------------------------------
// 2. Client Management (Singleton per userId)
// ----------------------------------------------------------------------
const globalForMcp = globalThis as unknown as { mcpClientMap?: Map<string, MultiSessionClient> };

function getMcpClient(userId: string): MultiSessionClient {
  if (!globalForMcp.mcpClientMap) {
    globalForMcp.mcpClientMap = new Map();
  }
  
  let client = globalForMcp.mcpClientMap.get(userId);
  if (!client) {
    client = new MultiSessionClient(userId);
    globalForMcp.mcpClientMap.set(userId, client);
  }
  
  return client;
}

// ----------------------------------------------------------------------
// 3. HITL (Human-in-the-Loop) Approval Logic
// ----------------------------------------------------------------------
/**
 * Determines if a tool call requires explicit user approval.
 * For testing purposes, we require approval on `readOnly` tools instead of `destructive` ones.
 */
function requiresApproval(tool: any, args: any, router: any): boolean {
  // Handle meta-tool proxy calls
  if (tool.name === 'toolrouter_call_tool') {
    const targetToolName = String(args?.toolName ?? "");
    const targetSourceId = String(args?.sourceId ?? "") || undefined;
    
    if (!targetToolName) return false;
    
    try {
      const targetTool = router.getToolSchema({ toolName: targetToolName, sourceId: targetSourceId });
      return (targetTool as any)?.annotations?.readOnlyHint === true;
    } catch {
      return false; // Tool not found, let execution fail normally
    }
  }

  // Handle direct tool calls (if any)
  return (tool.annotations as any)?.readOnlyHint === true;
}

// ----------------------------------------------------------------------
// 4. Agent Initialization
// ----------------------------------------------------------------------
export async function createMcpAgent(userId: string = process.env.NEXT_PUBLIC_MCP_USER_ID!) {
  const client = getMcpClient(userId);

  try {
    await client.connect();
  } catch (error) {
    console.error("[McpAgent] Failed to connect MCP client:", error);
  }

  // Set up Tool Router from @mcp-ts/toolrouter
  const router = await createToolRouter({
    sources: mcpSources(client),
    maxSearchResults: 8
  });

  // Set up Codemode Runtime
  const codemode = createCodeModeRuntime({ router });

  // Convert router meta-tools to AI SDK tools
  const routerTools = await createAISDKTools(router);

  // Define the codemode_run tool
  const codemodeTool = {
    description: "Run sandboxed JavaScript code for multi-step tool workflows. Use return to provide the final value.",
    parameters: z.object({
      code: z.string().describe("Async JavaScript body. Access tools via callTool(sourceId, toolName, args) and searchTools(query)."),
      input: z.unknown().optional().describe("Serializable input exposed as `input` in the sandbox.")
    }),
    execute: async ({ code, input }: { code: string; input?: unknown }) => {
      const result = await codemode.run(code, input);
      if (result.error) {
        throw new Error(`Codemode failed: ${result.error.message}`);
      }
      return result.value;
    }
  };

  // Combine all tools
  const allTools = {
    ...routerTools,
    codemode_run: codemodeTool
  };

  // Apply HITL approval to meta-tools
  Object.keys(allTools).forEach(name => {
    const tool = (allTools as any)[name];
    tool.needsApproval = (args: any) => requiresApproval({ name, annotations: tool.annotations }, args, router);
  });

  return new ToolLoopAgent({
    model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-chat"),
    instructions: INSTRUCTIONS,
    tools: allTools as any,
    stopWhen: stepCountIs(20),
  });
}

export type McpAgentUIMessage = InferAgentUIMessage<
  Awaited<ReturnType<typeof createMcpAgent>>
>;
