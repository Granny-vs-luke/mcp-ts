# @mcp-ts/tool-router

Dynamically search, fetch schemas, and route tool calls across multiple MCP servers to optimize LLM context.

`@mcp-ts/tool-router` lets an agent work with multiple MCP servers without loading every tool definition into the model context. Instead, the model receives a small set of meta-tools, searches for relevant tools, fetches schemas on demand, and calls tools through the router.

---

## Why Use It

When you have many tools, sending all schemas to the LLM is expensive and can exceed context limits. `ToolRouter` acts as an intermediary, keeping the active context small while preserving access to the full catalog.

Use it to:
- Index and search tools across multiple MCP servers or custom adapters.
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

### ToolServer

Anything that can list and call tools can be adapted into a `ToolServer`.

```typescript
import { createToolServer } from "@mcp-ts/tool-router";

const github = createToolServer({
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

- `search_tools`: Search the tool index without fetching full schemas.
- `list_servers`: List registered servers and tool counts.
- `get_tool_schemas`: Fetch input schemas for one or more specific tools.
- `call_tool`: Invoke a tool on a registered server.

Meta-tool calls return text content for compatibility and structured data in `structuredContent` for clients that can consume typed payloads.

### Pinned Tools

Use `pinnedTools` when a small number of tools should remain directly visible alongside the meta-tools. Prefer canonical ids such as `github.help`; legacy bare tool names such as `help` are still supported, but canonical ids avoid ambiguity when multiple servers expose the same tool name.

The router owns canonical ids: server ids are normalized to lowercase slug-style ids before they appear in tool ids. For example, `u2tsgODpOrlF.toolname` is treated as `u2tsgodporlf.toolname`.

### Deferred Tools

Use `deferredTools` for tools that should stay out of the initial client-visible tool list while remaining indexed for `search_tools`, schema lookup, and `call_tool`.

This is useful when you want an LLM to discover a tool only on demand instead of feeding it upfront. In practice:
- `pinnedTools` are directly visible
- `deferredTools` are meta-tool only
- `excludeTools` are removed entirely

Servers can also declare deferred-by-default tools with custom metadata:

```typescript
{
  name: "workflow_list",
  description: "List workflows",
  _meta: {
    toolRouter: {
      deferred: true
    }
  }
}
```

Router config still takes precedence, so you can pin a deferred-by-default tool when a specific client should see it directly.

### Excluded Tools

Use `excludeTools` to omit tools from the router catalog entirely. Excluded tools are not indexed, not searchable, not pinnable, and not callable through router meta-tools.

`excludeTools` supports the same matching ergonomics as `pinnedTools`:
- Canonical ids such as `exa.web_search_exa` exclude a specific tool.
- Bare names such as `web_search_exa` exclude matching tool names across all servers.
- Wildcards work in both forms, for example `exa.deep_*` or `crawling_*`.

---

## Basic Usage

```typescript
import { createToolRouter } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  servers: [github, linear, slack],
  metaToolNames: {
    searchTools: "find_tools",
    listServers: "servers",
    getToolSchemas: "tool_schemas",
    callTool: "run_tool"
  }
});

// Search tools
const results = await router.searchTools({
  query: "github open pull requests"
});

// Get tool input schema
const [schema] = router.getToolSchemas({
  toolIds: ["github.list_pull_requests"]
});

// Invoke tool
const pullRequests = await router.callTool({
  toolId: "github.list_pull_requests",
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
  servers: [github, slack]
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

## AI SDK Agent Example (Exa + grep)

This mirrors the pattern used in `examples/next/app/agent/agent.ts`.

```typescript
import { ToolLoopAgent, stepCountIs } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createToolRouter, createAISDKTools, mcpServer } from "@mcp-ts/tool-router";

const EXA_MCP_URL =
  "https://mcp.exa.ai/mcp?tools=web_search_exa,deep_search_exa,get_code_context_exa,crawling_exa";
const GREP_MCP_URL = "https://mcp.grep.app";

const instructions = `
You are an expert assistant that helps users with tasks using available MCP tools.
Use this flow:
1) list_servers
2) search_tools
3) get_tool_schemas
4) call_tool
Always search first before calling.
`;

async function createAgent() {
  const [exaClient, grepClient] = await Promise.all([
    createMCPClient({ transport: { type: "http", url: EXA_MCP_URL } }),
    createMCPClient({ transport: { type: "http", url: GREP_MCP_URL } })
  ]);

  const router = await createToolRouter({
    servers: [
      mcpServer("exa", exaClient),
      mcpServer("grep", grepClient)
    ],
    maxSearchResults: 8
  });

  const tools = await createAISDKTools(router);

  return new ToolLoopAgent({
    model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-chat"),
    instructions,
    tools: tools as any,
    stopWhen: stepCountIs(20)
  });
}
```

---

## MCP Client Adapters

Wrap any compatible tool client with `mcpServer`:

```typescript
import { createToolRouter, mcpServer, mcpServers } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  servers: [
    mcpServer("github", githubMcpClient),
    mcpServer("linear", linearMcpClient)
  ]
});
```

If you have a client provider that manages multiple active clients:

```typescript
const router = await createToolRouter({
  servers: mcpServers(multiSessionClient)
});
```

Using Vercel AI SDK MCP clients (`@ai-sdk/mcp`):

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { createToolRouter, mcpServer } from "@mcp-ts/tool-router";

const exa = await createMCPClient({ transport: { type: "http", url: "https://mcp.exa.ai/mcp" } });
const grep = await createMCPClient({ transport: { type: "http", url: "https://mcp.grep.app" } });

const router = await createToolRouter({
  servers: [mcpServer("exa", exa), mcpServer("grep", grep)]
});
```

---

## Policy Gates

Restrict tool execution with policies:

```typescript
const router = await createToolRouter({
  servers,
  excludeTools: ["grep.internal_*"],
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
- `createToolServer(server)`: Helper to type-check custom tool adapters.
- `createAISDKTools(router)`: Expose meta-tools as Vercel AI SDK tools.
- `mcpServer(id, client, name?)`: Wrap a `ToolClient`, including `@ai-sdk/mcp` clients, as a `ToolServer`.
- `mcpServers(provider)`: Convert a `ToolClientProvider` into `ToolServer[]`.

---

## License

MIT License.
