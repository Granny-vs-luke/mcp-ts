---
title: "Tool Router"
sidebarTitle: "Tool Router"
description: "Learn how the mcp-ts Tool Router middleware manages large MCP tool catalogs, routes tool calls intelligently, and keeps LLM context windows lean."
---

The **Tool Router** is a powerful middleware layer in `mcp-ts` designed to solve the problem of "context window bloat." 

When you connect to multiple MCP servers, the total number of tools can easily exceed 50 or 100. Injecting the full JSON schema for every tool into an LLM's context window is expensive, slow, and can lead to degraded model performance.

The `ToolRouter` sits between your AI adapter and your MCP clients, allowing you to control exactly how and when tools are exposed to the model.

## Strategies

The `ToolRouter` supports three primary strategies for tool filtering:

### 1. The `all` Strategy (Default)
In this strategy, every discovered tool is passed through to the LLM. 
- **Pros**: Zero latency, simple configuration.
- **Cons**: High token usage, limited by the model's context window.
- **Best for**: Small projects with fewer than 10-15 tools.

### 2. The `search` Strategy (Scalability)
This is the most advanced strategy. Instead of exposing your real tools, the SDK injects 5 system **Meta-Tools**. The LLM then "searches" for the tools it needs on-demand.
- **Pros**: Virtually unlimited scalability (1000+ tools), minimal token usage, higher accuracy.
- **Cons**: Requires a 2-turn flow for tool discovery.
- **Best for**: Enterprise applications and deep tool catalogs.

### 3. The `groups` Strategy (Contextual)
Expose specific groups of tools based on the current application state or user intent.
- **Pros**: Highly predictable, manageable token usage.
- **Cons**: Requires manual group definitions.
- **Best for**: UI-driven applications where only a subset of capabilities is relevant at a time.

---

## Basic Usage

To use the `ToolRouter`, initialize it with your `MultiSessionClient` and pass it to the `AIAdapter`.

```typescript
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";

export async function createMcpAgent(userId: string = "user-123") {
  const client = new MultiSessionClient(userId);
  await client.connect();

  // Dynamic import for ToolRouter (shared SDK utility)
  const { ToolRouter } = await import("@mcp-ts/sdk/shared");
  
  // Configure the router for high scalability (discovery strategy)
  const router = new ToolRouter(client, { strategy: "search" });
  
  // Initialize the adapter with the router
  const adapter = new AIAdapter(client, { toolRouter: router });
  
  // Expose the tools to your AI framework (e.g. Vercel AI SDK)
  const tools = await adapter.getTools();
  
  return tools;
}
```

## Options Reference

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `strategy` | `all` \| `search` \| `groups` | `all` | The filtering strategy to use. |
| `maxTools` | `number` | `40` | Max tools to return in search results or groups. |
| `groups` | `Record<string, string[]>` | `null` | Custom tool group definitions. |
| `activeGroups`| `string[]` | `[]` | Groups to expose when using `groups` strategy. |
| `compactSchemas`| `boolean` | `false` | Strips inputSchemas from all tools to save space. |

---

## Advanced: Semantic Search

By default, the `search` strategy uses keyword-based BM25 matching. For even better results, you can provide an `embedFn` to enable semantic search.

```typescript
const router = new ToolRouter(client, {
  strategy: 'search',
  embedFn: async (text) => {
    // Return embeddings from OpenAI, Voyage, etc.
    return await getEmbeddings(text);
  }
});
```

---

## Standalone package: `@mcp-ts/tool-router`

The Tool Router also ships as a zero-dependency standalone package you can drop into any agent or framework — even when you are not using the rest of `mcp-ts`. It exposes the same meta-tool pattern (`search_tools`, `list_sources`, `get_tool_schema`, `call_tool`) over a generic `ToolSource` abstraction, so you can route across multiple MCP servers, custom tool sources, or a mix of both.

Use the standalone package when:

- You already have one or more MCP clients (for example from `@ai-sdk/mcp`) and want to expose them to an LLM behind meta-tools.
- You want to keep large tool catalogs out of the model's context window without adopting the full `mcp-ts` server SDK.
- You need to plug custom, non-MCP tool sources into the same discovery flow.

### Install

```bash
npm install @mcp-ts/tool-router
```

### Quickstart with the Vercel AI SDK

The `asToolSource` adapter wraps any compatible MCP client — including those returned by `@ai-sdk/mcp` — into a `ToolSource` that the router can index. `createAISDKTools` then exposes the four meta-tools as a Vercel AI SDK tool set.

```typescript
import { ToolLoopAgent, stepCountIs } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  createToolRouter,
  createAISDKTools,
  asToolSource
} from "@mcp-ts/tool-router";

const instructions = `
You are an expert assistant. Use this flow:
1) list_sources
2) search_tools
3) get_tool_schema
4) call_tool
Always search first before calling.
`;

const [exa, grep] = await Promise.all([
  createMCPClient({ transport: { type: "http", url: "https://mcp.exa.ai/mcp" } }),
  createMCPClient({ transport: { type: "http", url: "https://mcp.grep.app" } })
]);

const router = await createToolRouter({
  sources: [asToolSource("exa", exa), asToolSource("grep", grep)],
  maxSearchResults: 8
});

const tools = await createAISDKTools(router);

const agent = new ToolLoopAgent({
  model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-chat"),
  instructions,
  tools: tools as any,
  stopWhen: stepCountIs(20)
});
```

### Customizing meta-tool names

By default the standalone router exposes meta-tools as `search_tools`, `list_sources`, `get_tool_schema`, and `call_tool`. If those names collide with your own tools — or you prefer a different convention — pass `metaToolNames` to override any subset:

```typescript
const router = await createToolRouter({
  sources: [asToolSource("github", github)],
  metaToolNames: {
    searchTools: "find_tools",
    listSources: "sources",
    getToolSchema: "tool_schema",
    callTool: "run_tool"
  }
});
```

Update your agent's system prompt to match the names you choose so the model calls the meta-tools in the right order.

For the full API surface — including `createToolSource`, `mcpSource`, and policy gates — see the [Tool Router API reference](/reference/tool-router).
