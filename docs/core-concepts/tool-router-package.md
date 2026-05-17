---
title: "Tool Router Package"
sidebarTitle: "Tool Router Package"
description: "Use the standalone @mcp-ts/tool-router package to search, fetch schemas, and route tool calls across multiple MCP servers without bloating LLM context."
icon: "box"
---

`@mcp-ts/tool-router` is a standalone npm package that lets an agent work with many MCP servers without loading every tool definition into the model context. The model receives a small set of meta-tools, searches for relevant tools, fetches schemas on demand, and calls tools through the router.

It is a zero-dependency package that you can use without the rest of the SDK. If you already use the in-SDK [`ToolRouter`](/core-concepts/tool-router) middleware, the standalone package exposes the same idea as a portable library that any MCP-compatible agent can adopt.

## When to use it

Use the package when you want to:

- Index and search tools across multiple MCP servers or custom sources.
- Expose a small set of meta-tools so the LLM dynamically loads schemas only when needed.
- Gate tool calls with allow lists, deny lists, or human approval.
- Integrate with the Vercel AI SDK without pulling in the full `@mcp-ts/sdk`.

If you are already inside an `@mcp-ts/sdk` agent with `MultiSessionClient`, the built-in `ToolRouter` middleware is the path of least resistance. Reach for the standalone package when you need a smaller dependency footprint or want to ship a router in a non-SDK runtime.

## Installation

```bash
npm install @mcp-ts/tool-router
```

## Core concepts

### Tool sources

Anything that can list and call tools can be adapted into a `ToolSource`:

```typescript
import { createToolSource } from "@mcp-ts/tool-router";

const github = createToolSource({
  id: "github",
  name: "GitHub",
  listTools: async () => ({
    tools: [
      {
        name: "list_pull_requests",
        description: "List pull requests for a repository.",
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

### Meta-tools

The router exposes four meta-tools to the LLM:

| Meta-tool | Purpose |
| :-- | :-- |
| `toolrouter_search_tools` | Search the tool index without fetching full schemas. |
| `toolrouter_list_sources` | List registered sources and tool counts. |
| `toolrouter_get_tool_schema` | Fetch the input schema for a specific tool. |
| `toolrouter_call_tool` | Invoke a tool on a registered source. |

The model only ever sees these four tools, regardless of how large the underlying catalog grows.

## Basic usage

```typescript
import { createToolRouter } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  sources: [github, linear, slack]
});

// Search the indexed tools
const results = await router.searchTools({
  query: "github open pull requests"
});

// Fetch the input schema for a specific tool
const schema = router.getToolSchema({
  sourceId: "github",
  toolName: "list_pull_requests"
});

// Invoke a tool through the router
const pullRequests = await router.callTool({
  sourceId: "github",
  toolName: "list_pull_requests",
  args: {
    owner: "zonlabs",
    repo: "mcp-ts"
  }
});
```

## AI SDK integration

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

The model sees only the four meta-tools at the start of the conversation, then discovers and calls real tools on demand.

## Wrapping MCP clients

To use existing MCP clients as sources, wrap them with `mcpSource`:

```typescript
import { createToolRouter, mcpSource, mcpSources } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  sources: [
    mcpSource("github", githubMcpClient),
    mcpSource("linear", linearMcpClient)
  ]
});
```

If you have a provider that manages multiple active clients, use `mcpSources` to convert them in one call:

```typescript
const router = await createToolRouter({
  sources: mcpSources(multiSessionClient)
});
```

## Policy gates

Restrict which tools can be executed with a `policy` object:

```typescript
const router = await createToolRouter({
  sources,
  policy: {
    allowTools: ["github.*", "linear.*"],
    denyTools: ["github.delete_*"],
    denyDestructiveTools: true,
    approveToolCall: async ({ tool, args }) => {
      // Custom approval logic, e.g. prompt a human.
      return tool.annotations?.destructiveHint !== true;
    }
  }
});
```

| Option | Description |
| :-- | :-- |
| `allowTools` | Glob patterns of tool ids permitted to run. |
| `denyTools` | Glob patterns that are always rejected. |
| `denyDestructiveTools` | Block any tool whose annotations mark it destructive. |
| `approveToolCall` | Async callback that returns `true` to allow a call. |

Policies are evaluated before any tool is invoked, so denied calls never reach your sources.

## API summary

| Export | Description |
| :-- | :-- |
| `createToolRouter(options)` | Create and initialize a `ToolRouter`. |
| `createToolSource(source)` | Helper to type-check a custom tool source. |
| `createAISDKTools(router)` | Expose the meta-tools as Vercel AI SDK tools. |
| `mcpSource(id, client, name?)` | Wrap an MCP-compatible client as a `ToolSource`. |
| `mcpSources(provider)` | Convert multiple client instances into `ToolSource[]`. |
