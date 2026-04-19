---
title: "Mastra"
sidebarTitle: "Mastra"
description: "High-performance MCP integration for the Mastra framework."
icon: "bolt"
---

The `MastraAdapter` converts MCP tools into the format expected by the [Mastra](https://mastra.ai) framework.

## Installation

```bash
npm install @mcp-ts/sdk zod
```

## Usage

```typescript
import { MultiSessionClient } from '@mcp-ts/sdk/server';
import { MastraAdapter } from '@mcp-ts/sdk/adapters/mastra';

const client = new MultiSessionClient('user_123');
await client.connect();

const adapter = new MastraAdapter(client);
const tools = await adapter.getTools();

// Use with Mastra agent
const agent = new Agent({
  tools,
  // ...
});
```

## API Reference

See the [MastraAdapter API Reference](/api-reference/server#adapters) for more details.
