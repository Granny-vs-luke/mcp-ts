---
title: "Tool Router API"
sidebarTitle: "Tool Router"
description: "API reference for the Tool Router middleware: configuration, meta-tools, search scoring options, and runtime hooks for managing large MCP tool catalogs."
icon: "route"
---

Instead of injecting all tools at once, you can let the LLM discover and load tools on-demand using BM25 or semantic search.

### `ToolRouter`

```typescript
import { ToolRouter } from '@mcp-ts/sdk/shared';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

const router = new ToolRouter(client: MCPClient | MultiSessionClient, {
  // 'all' (default), 'search' (exposes meta-tools only), or 'groups'
  strategy: 'search',
  
  // Max tools to return from a search or group (default: 40)
  maxTools: 5,
  
  // Optional embedding function for semantic search
  embedFn: async (texts) => {
    const { embeddings } = await embed({
      model: openai.embedding('text-embedding-3-small'),
      values: texts,
    });
    return embeddings;
  },
  
  // Weight between keyword (BM25) and embedding search (0 to 1, default: 0.4)
  keywordWeight: 0.4,
});
```

**Methods:**
- `getFilteredTools()` - Get tools based on current strategy
- `searchTools(query, topK?, options?)` - Search via BM25 + embeddings, optionally scoped by exact `serverId` or fragment-based `serverName`
- `searchToolsRegex(pattern, topK?)` - Search via regex pattern
- `listServers(options?)` - List connected indexed servers with tool counts
- `listTools(options?)` - Deterministically list indexed tools, optionally scoped by server and paginated with `cursor`
- `refresh()` - Re-index tools from all connected clients
- `setStrategy(strategy)` - Change tool selection strategy at runtime

Use the ToolRouter with adapters like `AIAdapter`:

```typescript
const adapter = new AIAdapter(client, {
  toolRouter: router
});
const tools = await adapter.getTools();
```

### `ToolIndex`

Lightweight in-memory search index used internally by `ToolRouter`, or directly for specific custom discovery flows.

```typescript
import { ToolIndex } from '@mcp-ts/sdk/shared';

const index = new ToolIndex({
  embedFn: async (texts) => [/* ... */],
  keywordWeight: 0.4
});

await index.buildIndex(tools);

// Returns ToolSummary[] using BM25 and explicit/optional embeddings
const results = await index.search("query", 5);

// Regex search
const regexResults = index.searchRegex("get_.*_data", 5);

// Search one server by human-readable name fragment.
// This matches a server named "Database MCP".
const databaseResults = await index.search("tables", 5, {
  serverName: "database",
});

// Search one server by exact stable ID.
const exactServerResults = await index.search("tables", 5, {
  serverId: "database-server",
});

// List every tool from one server with pagination metadata.
const listed = index.listTools({
  serverName: "database",
  limit: 100,
});
console.log(listed.totalCount, listed.tools);
```

---

## Standalone Package API (`@mcp-ts/tool-router`)

The standalone [`@mcp-ts/tool-router`](/core-concepts/tool-router#standalone-package-mcp-ts-tool-router) package exposes the Tool Router pattern over a generic `ToolSource` abstraction. Use it when you want meta-tool routing without the rest of the SDK.

### `createToolRouter(options)`

Create and initialize a `ToolRouter` from one or more `ToolSource` adapters.

```typescript
import { createToolRouter, asToolSource } from "@mcp-ts/tool-router";

const router = await createToolRouter({
  sources: [asToolSource("github", githubClient)],
  maxSearchResults: 8,
  excludeMetaTools: [],
  metaToolNames: {
    searchTools: "search_tools",
    listSources: "list_sources",
    getToolSchema: "get_tool_schema",
    callTool: "call_tool"
  }
});
```

**Options:**

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `sources` | `ToolSource[]` | required | Tool sources to index and route to. |
| `maxSearchResults` | `number` | `10` | Default cap for `search_tools` results (max 100). |
| `policy` | `ToolRouterPolicy` | – | Allow/deny lists and a custom gate function for tool calls. |
| `excludeMetaTools` | `string[]` | `[]` | Names of meta-tools to omit (after renaming). |
| `metaToolNames` | `Partial<ToolRouterMetaToolNames>` | see below | Override one or more meta-tool names. |

**Default meta-tool names** (from `DEFAULT_TOOLROUTER_META_TOOL_NAMES`):

```typescript
{
  searchTools: "search_tools",
  listSources: "list_sources",
  getToolSchema: "get_tool_schema",
  callTool: "call_tool"
}
```

Search ranks candidates with BM25 over tool name, source, and description, so common terms in unrelated tools no longer dominate the results.

### `asToolSource(id, client, name?)`

Adapt any compatible MCP client — including those returned by `@ai-sdk/mcp` — to a `ToolSource`. The adapter lazily caches the client's `tools()` map on first call so each tool invocation reuses the same handle.

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { asToolSource } from "@mcp-ts/tool-router";

const exa = await createMCPClient({
  transport: { type: "http", url: "https://mcp.exa.ai/mcp" }
});

const source = asToolSource("exa", exa, "Exa Search");
```

The client must implement `listTools()` (returning `{ tools: [...] }`) and `tools()` (returning a record of executable tools). Both shapes are exported as the `MCPClient` interface.

### `createAISDKTools(router)`

Wrap a router's meta-tools as a Vercel AI SDK tool set. Pass the returned object to `ToolLoopAgent` (or any AI SDK call site that accepts a tool set):

```typescript
import { createAISDKTools } from "@mcp-ts/tool-router";

const tools = await createAISDKTools(router);
```

### Other Exports

- `createToolSource(source)` — identity helper that type-checks a custom `ToolSource` implementation.
- `mcpSource(id, client, name?)` / `mcpSources(provider)` — wrap MCP-style clients that expose `listTools` and `callTool` directly.
- `createMetaTools(names?)` — return the raw meta-tool definitions (useful when integrating with a non-AI-SDK framework).
- `DEFAULT_TOOLROUTER_META_TOOL_NAMES` — the default mapping for `metaToolNames`.

Exported types include `ToolSource`, `ToolRouterOptions`, `ToolRouterMetaTool`, `ToolRouterMetaToolNames`, `ToolSearchResult`, `ToolSchemaResult`, `ToolRouterCallResult`, and `MCPClient`.

---

### `SchemaCompressor`

Utility for yielding compact tool representations (name + description + inline parameterHint) without the full `inputSchema`.

```typescript
import { SchemaCompressor } from '@mcp-ts/sdk/shared';

// Get a compact schema omitting full `inputSchema`
const compact = SchemaCompressor.toCompact(tool);
```
