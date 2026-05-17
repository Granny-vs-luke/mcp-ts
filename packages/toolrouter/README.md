# @mcp-ts/tool-router

Dynamically search, fetch schemas, and route tool calls across multiple MCP servers to optimize LLM context.

`@mcp-ts/tool-router` lets an agent work with multiple MCP servers without loading every tool definition into the model context. Instead, the model receives a small set of meta-tools, searches for relevant tools, fetches schemas on demand, and calls tools through the router.

---

## Why Use It

When you have many tools, sending all schemas to the LLM is expensive and can exceed context limits. `ToolRouter` acts as an intermediary, keeping the active context small while preserving access to the full catalog.

Use it to:
- Index and search tools across multiple MCP servers or custom sources.
- Expose a small set of meta-tools for dynamic schema loading.
- Control tool calls with allow/deny rules and approval gates.
- Integrate with Vercel AI SDK.

---

## Installation

```bash
npm install @mcp-ts/tool-router
```

---

## Core Concepts

### ToolSource

Anything that can list and call tools can be adapted into a `ToolSource`.

```typescript
import { createToolSource } from "@mcp-ts/tool-router";

const github = createToolSource({
  id: "github",
  name: "GitHub",
  listTools: async () => ({
    tools: [
      {
        name: "list_pull_requests",
        description: "List pull requests for a repository",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" }
          },
          required: ["owner", "repo"]
        }
      }
    ]
  }),
  callTool: async (name, args) => {
    return callYourMcpClient(name, args);
  }
});
```

### Meta-Tools

The router exposes four meta-tools to LLMs:

- `toolrouter_search_tools`: Search the tool index without fetching full schemas.
- `toolrouter_list_sources`: List registered sources and tool counts.
- `toolrouter_get_tool_schema`: Fetch the input schema for a specific tool.
- `toolrouter_call_tool`: Invoke a tool on a registered source.

---

## Basic Usage

```typescript
import { createToolRouter } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  sources: [github, linear, slack]
});

// Search tools
const results = await router.searchTools({
  query: "github open pull requests"
});

// Get tool input schema
const schema = router.getToolSchema({
  sourceId: "github",
  toolName: "list_pull_requests"
});

// Invoke tool
const pullRequests = await router.callTool({
  sourceId: "github",
  toolName: "list_pull_requests",
  args: {
    owner: "zonlabs",
    repo: "mcp-ts"
  }
});
```

---

## AI SDK Integration

Use `createAISDKTools` to expose the router's meta-tools to the Vercel AI SDK:

```typescript
import { generateText } from "ai";
import { createToolRouter, createAISDKTools } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  sources: [github, slack]
});

const tools = await createAISDKTools(router);

const result = await generateText({
  model,
  tools,
  prompt: "Find open GitHub PRs about authentication."
});
```

The model only sees the meta-tools rather than the entire tool catalog at start.

---

## MCP Client Adapters

Wrap any compatible MCP client with `mcpSource`:

```typescript
import { createToolRouter, mcpSource, mcpSources } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  sources: [
    mcpSource("github", githubMcpClient),
    mcpSource("linear", linearMcpClient)
  ]
});
```

If you have a client provider that manages multiple active clients:

```typescript
const router = await createToolRouter({
  sources: mcpSources(multiSessionClient)
});
```

---

## Policy Gates

Restrict tool execution with policies:

```typescript
const router = await createToolRouter({
  sources,
  policy: {
    allowTools: ["github.*", "linear.*"],
    denyTools: ["github.delete_*"],
    denyDestructiveTools: true,
    approveToolCall: async ({ tool, args }) => {
      // Custom approval logic
      return tool.annotations?.destructiveHint !== true;
    }
  }
});
```

---

## API Reference

Main exports:
- `createToolRouter(options)`: Create and initialize a `ToolRouter`.
- `createToolSource(source)`: Helper to type-check custom tool sources.
- `createAISDKTools(router)`: Expose meta-tools as Vercel AI SDK tools.
- `mcpSource(id, client, name?)`: Wrap an MCP-like client as a `ToolSource`.
- `mcpSources(provider)`: Convert multiple client instances to `ToolSource[]`.

---

## License

MIT License.
