import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { MultiSessionClient, sessions, withDbObservability } from "@mcp-ts/sdk/server";
import type { McpObservabilityEvent } from "@mcp-ts/sdk/shared";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

const { ToolRouter } = await import("@mcp-ts/sdk/shared");

// ----------------------------------------------------------------------
// 1. Agent Instructions
// ----------------------------------------------------------------------
const INSTRUCTIONS = `
You are an expert assistant, an AI assistant that helps users with their tasks using the available MCP tools.

IMPORTANT: When a tool requires user approval, explain what you intend to do and why before calling it.
If the user denies a tool call, acknowledge their decision and suggest alternatives.
`;

// ----------------------------------------------------------------------
// 2. Client Management (Fresh per request for serverless testing)
// ----------------------------------------------------------------------
function createMcpClient(userId: string): MultiSessionClient {
  const store = withDbObservability(sessions, (event: McpObservabilityEvent) => {
    console.log(`[DB][${event.type}] ${event.message} (${event.payload?.durationMs?.toFixed(1) ?? '?'}ms)`);
  });

  return new MultiSessionClient(userId, {
    sessionStore: store,
    onObservabilityEvent: (event: McpObservabilityEvent) => {
      const prefix = `[MCP][${event.serverId ?? event.sessionId ?? '?'}]`;
      switch (event.level) {
        case 'error':
          console.error(prefix, event.message, event.payload ?? '');
          break;
        case 'warn':
          console.warn(prefix, event.message, event.payload ?? '');
          break;
        case 'debug':
          console.debug(prefix, event.message, event.payload ?? '');
          break;
        default:
          console.log(prefix, event.message, event.payload ?? '');
      }
    },
  });
}

// ----------------------------------------------------------------------
// 3. HITL (Human-in-the-Loop) Approval Logic
// ----------------------------------------------------------------------
/**
 * Determines if a tool call requires explicit user approval.
 * For testing purposes, we require approval on `readOnly` tools instead of `destructive` ones.
 */
function requiresApproval(tool: any, args: any, router: any): boolean {
  // Handle meta-tool proxy calls: If the LLM uses mcp_execute_tool, 
  // we must look up the annotations on the actual target tool.
  if (tool.name === 'mcp_execute_tool') {
    const targetToolName = String(args?.toolName ?? "");
    const targetNamespace = String(args?.serverId ?? "") || undefined;

    if (!targetToolName) return false;

    try {
      const targetTool = router.getToolSchema(targetToolName, targetNamespace);
      return (targetTool as any)?.annotations?.destructiveHint === true;
    } catch {
      return false; // Tool not found, let execution fail normally
    }
  }

  // Handle direct tool calls (when not using search/meta-tool routing)
  return (tool.annotations as any)?.readOnlyHint === true;
}

// ----------------------------------------------------------------------
// 4. Agent Initialization
// ----------------------------------------------------------------------
export async function createMcpAgent(userId: string = process.env.NEXT_PUBLIC_MCP_USER_ID!) {
  const client = createMcpClient(userId);

  // Always call connect to synchronize with the database.
  // MultiSessionClient safely skips already-connected sessions.
  try {
    await client.connect();
  } catch (error) {
    console.error("[McpAgent] Failed to connect MCP client:", error);
  }

  // Set up Tool Router and Adapter
  const router = new ToolRouter(client, { strategy: "search", maxTools: 5 });
  const adapter = new AIAdapter(client, {
    toolRouter: router,
    needsApproval: (tool, args) => requiresApproval(tool, args, router),
  });

  const tools = await adapter.getTools();

  return new ToolLoopAgent({
    model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-chat"),
    instructions: INSTRUCTIONS,
    tools: tools as any,
    stopWhen: stepCountIs(20),
  });
}

export type McpAgentUIMessage = InferAgentUIMessage<
  Awaited<ReturnType<typeof createMcpAgent>>
>;