import { ToolLoopAgent, InferAgentUIMessage, stepCountIs, jsonSchema } from "ai";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createToolRouter, mcpSources, createAISDKTools, TOOLROUTER_CALL_TOOL } from "@mcp-ts/toolrouter";
import { createCodeModeRuntime } from "@mcp-ts/codemode";
import { z } from "zod";

// ----------------------------------------------------------------------
// 1. Agent Instructions
// ----------------------------------------------------------------------
const INSTRUCTIONS = `
You are an expert assistant that helps users perform complex tasks using MCP tools. 

### 1. Tool Discovery Phase
**Always start by discovering available tools:**
- Tools are organized by Source ID (e.g., 'notion', 'exa').
- Use 'toolrouter_search_tools' to find candidates. Do not guess tool names.
- Multiple sources might have tools with similar names; always verify the 'sourceId'.

### 2. Interface Introspection
**Understand tool contracts before using them:**
- Use 'toolrouter_get_tool_schema' to fetch the 'inputSchema' for any tool.
- Schemas show required inputs, property descriptions, and expected types.
- Always check the schema before calling a tool or writing codemode scripts.

### 3. Code Execution Guidelines
**When writing code for 'codemode_run':**
- **Atomic Workflows**: Aim to complete the entire requested multi-service workflow in a SINGLE 'codemode_run' call. Do not split search, transformation, and output into separate chat turns unless absolutely necessary for user feedback.
- Your code runs as the body of an async function. Use 'return' for the final value.
- Use 'await callTool(sourceId, toolName, args)' to execute tools. This is your ONLY way to execute tools.
- **Data Chaining**: Capture the result of one 'callTool' and pass it directly to the next.
- Use 'await searchTools(query)' to find tools dynamically from within code.
- You have access to globals: 'console', 'JSON', 'Math', 'Date', and the optional 'input' object.
- Console output is captured and returned with the result.
- Handle errors with try/catch blocks for robustness.

### 4. Best Practices
- **Minimize Turns**: One 'codemode_run' call should replace multiple 'toolrouter_call_tool' calls.
- **Search -> Inspect -> Execute**: Never call a tool without knowing its source and schema.
- **Source Specificity**: Always provide 'sourceId' to 'callTool' to avoid ambiguity.
- **Transformation**: Use standard JS (map, filter, reduce) inside the script to clean data before passing it to the next service.
- **HITL Approval**: Explain your intent before calling tools that require user approval.

Remember: Thorough discovery and schema inspection lead to reliable execution.
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
    maxSearchResults: 8,
    excludeMetaTools: [TOOLROUTER_CALL_TOOL]
  });

  // Set up Codemode Runtime
  const codemode = createCodeModeRuntime({ router });

  // Convert router meta-tools to AI SDK tools
  const routerTools = await createAISDKTools(router);

  // Define the codemode_run tool
  const codemodeTool = {
    description: "Run sandboxed JavaScript code for multi-step tool workflows. Use return to provide the final value.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Async JavaScript body. Access tools via callTool(sourceId, toolName, args) and searchTools(query)."
        },
        input: {
          description: "Serializable input exposed as `input` in the sandbox."
        }
      },
      required: ["code"]
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
