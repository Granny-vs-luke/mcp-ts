# @mcp-ts/toolrouter

Protocol-neutral tool discovery and proxy execution for agent applications.

`@mcp-ts/toolrouter` lets an agent work with many MCP servers without putting every tool schema into the model context. Instead, the model receives a small set of meta-tools, searches for relevant tools when needed, fetches only the schemas it needs, and calls the target tool through the router.

## Why Use It

Large MCP setups can expose dozens or hundreds of tools. Sending all of those definitions to the model is expensive, noisy, and often unnecessary. ToolRouter keeps the model context small while preserving access to the full tool catalog.

Use it when you want to:

- Search tools across multiple MCP servers or custom tool providers.
- Expose only a few meta-tools to the model.
- Fetch full schemas only after a tool is selected.
- Proxy execution to the correct MCP server.
- Add allow/deny and destructive-tool policy gates.
- Integrate with AI SDK without depending on `@mcp-ts/sdk`.

## Installation

```bash
npm install @mcp-ts/toolrouter
```

For local development inside this repository:

```bash
cd packages/toolrouter
npm install
npm run build
```

## Core Concepts

### ToolSource

ToolRouter is intentionally small and protocol-neutral. Anything that can list and call tools can be adapted into a `ToolSource`.

```ts
import { createToolSource } from "@mcp-ts/toolrouter";

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

The router exposes four meta-tools:

- `toolrouter_search_tools` - search the indexed catalog without returning full schemas.
- `toolrouter_list_sources` - list connected sources and tool counts.
- `toolrouter_get_tool_schema` - fetch the full schema for one selected tool.
- `toolrouter_call_tool` - proxy a call to the correct source.

The intended model flow is:

1. Search for candidate tools.
2. Fetch the schema for the selected tool.
3. Call the selected tool through the proxy.

## Basic Usage

```ts
import { createToolRouter } from "@mcp-ts/toolrouter";

const router = await createToolRouter({
  sources: [github, linear, slack],
  maxSearchResults: 8
});

const results = await router.searchTools({
  query: "github open pull requests",
  limit: 5
});

const schema = router.getToolSchema({
  sourceId: "github",
  toolName: "list_pull_requests"
});

const pullRequests = await router.callTool({
  sourceId: "github",
  toolName: "list_pull_requests",
  args: {
    owner: "zonlabs",
    repo: "mcp-ts",
    state: "open"
  }
});
```

Search results intentionally omit `inputSchema`. Fetch schemas only for tools the model actually plans to call.

## AI SDK Integration

Use `createAISDKTools` to expose only ToolRouter meta-tools to AI SDK.

```ts
import { generateText } from "ai";
import { createToolRouter, createAISDKTools } from "@mcp-ts/toolrouter";

const router = await createToolRouter({
  sources: [github, slack]
});

const tools = await createAISDKTools(router);

const result = await generateText({
  model,
  tools,
  prompt: "Find open GitHub PRs about authentication and summarize them."
});
```

The model receives only the meta-tools, not the full MCP tool catalog.

## MCP Client Adapters

If a client has `listTools()` and `callTool()`, wrap it with `mcpSource`.

```ts
import { createToolRouter, mcpSource, mcpSources } from "@mcp-ts/toolrouter";

const router = await createToolRouter({
  sources: [
    mcpSource("github", githubMcpClient),
    mcpSource("linear", linearMcpClient)
  ]
});
```

For providers that expose multiple clients:

```ts
const router = await createToolRouter({
  sources: mcpSources(multiSessionClient)
});
```

These helpers are structural. They do not require `@mcp-ts/sdk`; they also work with compatible custom MCP clients.

## Policy Gates

Use policy options to restrict what the router can execute.

```ts
const router = await createToolRouter({
  sources,
  policy: {
    allowTools: ["github.*", "linear.*"],
    denyTools: ["github.delete_*"],
    denyDestructiveTools: true,
    approveToolCall: async ({ tool, args }) => {
      return tool.annotations?.destructiveHint !== true;
    }
  }
});
```

Tool patterns use `sourceId.toolName`, for example `github.list_pull_requests`.

## Direct Meta-Tool Execution

Frameworks can call `executeMetaTool` directly when building adapters.

```ts
const response = await router.executeMetaTool("toolrouter_search_tools", {
  query: "slack send message"
});

if (!response.isError) {
  console.log(response.structuredContent);
}
```

Responses follow MCP-style content:

```ts
{
  content: [{ type: "text", text: "..." }],
  isError: false,
  structuredContent: ...
}
```

## API Reference

Main exports:

- `createToolRouter(options)` - creates and initializes a router.
- `ToolRouter` - router class with `searchTools`, `getToolSchema`, `callTool`, `getMetaTools`, `executeMetaTool`, and `refresh`.
- `createToolSource(source)` - identity helper for typed tool sources.
- `createAISDKTools(router)` - converts router meta-tools into AI SDK tools.
- `mcpSource(id, client, name?)` - adapts a single MCP-like client.
- `mcpSources(provider)` - adapts a provider with `getClients()`.

Important types:

- `ToolSource`
- `ToolDefinition`
- `ToolSearchResult`
- `IndexedTool`
- `ToolRouterPolicy`
- `ToolRouterMetaTool`

## Development

```bash
cd packages/toolrouter
npm run build
npm run type-check
npm test
```

The tests cover schema-less search, schema lookup, proxy execution, meta-tool execution, and destructive-tool policy enforcement.

## Relationship To Codemode

`@mcp-ts/codemode` builds on this package. ToolRouter handles discovery, schema loading, and tool execution; Codemode adds sandboxed multi-step JavaScript execution on top.

Use ToolRouter alone when you want the model to call tools directly through meta-tools. Add Codemode when you want the model to write a small program that performs multiple tool calls, loops, transforms data, or combines results inside a controlled runtime.
