---
title: "Meta Tools"
sidebarTitle: "Meta Tools"
description: "Technical reference for the system tools that power on-demand tool discovery."
---

When the `ToolRouter` is set to the `search` strategy, it hides your real MCP tools and instead exposes a small set of **Meta-Tools**. 

These tools follow the "Tool Search" pattern, allowing the LLM to autonomously find, inspect, and execute relevant capabilities from a massive catalog.

## The Meta-Tool Catalog

### `mcp_search_tool_bm25`
The primary entry point for discovery. The LLM calls this with a natural language query to find tools. The backend uses an in-memory BM25 index combined with smart heuristics to rank results.
- **Input**: `query` (string), `limit` (number).
- **Output**: A list of tool names, descriptions, and the servers they belong to.

#### Advanced Search Features
The `mcp_search_tool_bm25` meta-tool supports a powerful query syntax that helps the AI zero in on exact capabilities without context bloat:

- **Direct Tool Selection (`select:<name>`)**: If the AI already knows the exact tool it wants to use (e.g., from past context), it can bypass the BM25 index entirely.
  - *Example*: `select:github_create_issue` returns the exact tool description instantly.
- **Required Terms (`+term`)**: By prefixing a word with `+`, the AI strictly forces the index to *only* return tools that contain that word in their name or description.
  - *Example*: `+slack send` guarantees that only tools belonging to Slack are returned, even if another tool uses the word "send" frequently.
- **Enhanced Scoring Heuristics**: Behind the scenes, the BM25 index automatically grants massive score bonuses (+10 or +5 points) if a search term perfectly matches or is a substring of the MCP `serverName` or the tool `name`. This ensures that tools strictly related to a specific integration (e.g., querying for "neon" or "apify") always float above unrelated tools that merely mention the word in their parameters.

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
