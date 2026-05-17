import { ToolLoopAgent, InferAgentUIMessage, stepCountIs } from "ai";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createCodeModeRuntime, mcpSources, createCodemodeAITools } from "@mcp-ts/codemode";

// ----------------------------------------------------------------------
// 1. Agent Instructions
// ----------------------------------------------------------------------
const INSTRUCTIONS = `
You are an expert assistant that helps users perform complex tasks using MCP tools. 

### 1. Tool Discovery Phase
**Always start by discovering available tools:**
- Tools are organized by Source ID (e.g., 'github', 'exa', 'notion').
- Use 'codemode_search_tools' to find candidates. Do not guess tool names.
- Use 'codemode_list_sources' if you just want to see what systems are connected.

### 2. Interface Introspection
**Understand tool contracts before using them:**
- Use 'codemode_tools_info' to fetch the TypeScript interfaces for tools you want to use.
- Pass tool names in the format 'sourceId.toolName' (e.g., ['github.get_issue', 'exa.web_search']).
- Always check the schema before calling a tool or writing codemode scripts.

### 3. Code Execution Guidelines
**When writing code for 'codemode_run':**
- **Atomic Workflows**: Aim to complete the entire requested multi-service workflow in a SINGLE 'codemode_run' call. Do not split search, transformation, and output into separate chat turns.
- Your code runs as the body of an async function. Use 'return' for the final value.
- **Direct Namespace Access**: Tools are available as synchronous namespace functions. 
  Example: \`const issue = github.get_issue({ issue_number: 42 });\`
- **No Await Needed**: Tool calls block the sandbox and return synchronously. You do not need to \`await\` them, but using \`await\` is also fine.
- **Data Chaining**: Capture the result of one tool and pass it directly to the next.
- You have access to globals: 'console', 'JSON', 'Math', 'Date', and the optional 'input' object.
- Console output is captured and returned with the result. Use console.log for debugging.
- Handle errors with try/catch blocks for robustness.
- If you need to search or inspect schemas from *within* your code at runtime, you can use:
  - \`searchTools(query, limit)\`
  - \`__interfaces\` (global string containing all typings)
  - \`__getToolInterface('sourceId.toolName')\`

### 4. Best Practices
- **Minimize Turns**: One 'codemode_run' call should replace multiple chat turns.
- **Search -> Inspect -> Execute**: Never call a tool without knowing its source and schema.
- **Transformation**: Use standard JS (map, filter, reduce) inside the script to clean data before passing it to the next service.

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
// 3. Agent Initialization
// ----------------------------------------------------------------------
export async function createMcpAgent(userId: string = process.env.NEXT_PUBLIC_MCP_USER_ID!) {
  const client = getMcpClient(userId);

  try {
    await client.connect();
  } catch (error) {
    console.error("[McpAgent] Failed to connect MCP client:", error);
  }

  // Set up Codemode Runtime using MCP clients as sources
  const runtime = await createCodeModeRuntime({
    sources: mcpSources(client),
    limits: {
      timeoutMs: 30000, // 30 seconds for complex multi-tool workflows
      maxToolCalls: 50,
    }
  });

  // Create AI SDK tools from the codemode runtime
  const allTools = await createCodemodeAITools(runtime);

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

