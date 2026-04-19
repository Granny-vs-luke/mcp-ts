---
title: "Meta Tools"
description: "Technical reference for the system tools that power on-demand tool discovery."
icon: "wand-magic-sparkles"
---

When the `ToolRouter` is set to the `search` strategy, it hides your real MCP tools and instead exposes a small set of **Meta-Tools**. 

These tools follow the "Tool Search" pattern, allowing the LLM to autonomously find, inspect, and execute relevant capabilities from a massive catalog.

## The Meta-Tool Catalog

### `mcp_search_tool_bm25`
The entry point for discovery. The LLM calls this with a natural language query to find tools.
- **Input**: `query` (string), `limit` (number).
- **Output**: A list of tool names, descriptions, and the servers they belong to.
- **Usage**: "I need to query a database" → returns `sql_query`, `list_tables`, etc.

### `mcp_search_tool_regex`
A precision tool for finding specific patterns in tool names or descriptions.
- **Input**: `query` (Regex string), `limit` (number).
- **Output**: Matching tools.
- **Usage**: `^github_.*` → returns all tools starting with "github_".

### `mcp_get_tool_schema`
Load the technical details for a specific tool.
- **Input**: `toolName` (string), `serverName` (optional string).
- **Output**: The full JSON `inputSchema` for the requested tool.
- **Requirement**: The LLM *must* call this after searching to know what arguments a tool accepts.

### `mcp_execute_tool`
The proxy executor for all discovered tools.
- **Input**: `toolName` (string), `args` (object), `serverName` (optional string).
- **Output**: The result of the actual MCP tool call.
- **Privacy**: The SDK handles the routing to the correct MCP server automatically.

---

## The Discovery Lifecycle

The `mcp-ts` SDK implements the following flow to minimize context usage while maintaining capability:

<Steps>
  <Step title="Initial Injection">
    The SDK injects only the 4 Meta-Tools into the LLM context (cost: ~500 tokens).
  </Step>
  <Step title="Discovery (Search)">
    When the user asks for a specific capability, the LLM calls `mcp_search_tool_bm25` or `mcp_search_tool_regex`.
  </Step>
  <Step title="Inspection (Get Schema)">
    Based on search results, the LLM calls `mcp_get_tool_schema` for the most relevant tool to see its parameters.
  </Step>
  <Step title="Execution">
    The LLM calls `mcp_execute_tool` with the constructed arguments. The SDK routes this call to the matching MCP server and returns the result.
  </Step>
</Steps>

## Why use Meta-Tools?

1. **Context Density**: You can give an LLM access to 1,000 tools without using more than a few hundred tokens of "resting" context.
2. **Reduced Hallucinations**: Because the LLM "finds" the tool definition right before using it, it is less likely to hallucinate parameters or use the wrong tool.
3. **Multi-Server Conflict Resolution**: If two servers provide a tool named `search`, the Meta-Tools return the `serverName` as a namespace, allowing the LLM to specify which one to use.
