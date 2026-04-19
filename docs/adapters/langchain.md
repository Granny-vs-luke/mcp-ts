---
title: "LangChain"
description: "Connect LangChain agents to any MCP server."
---

The `LangChainAdapter` converts MCP tools into LangChain's `DynamicStructuredTool` format.

## Installation

```bash
npm install @mcp-ts/sdk @langchain/core zod
```

## Usage

```typescript
import { MultiSessionClient } from '@mcp-ts/sdk/server';
import { LangChainAdapter } from '@mcp-ts/sdk/adapters/langchain';

const client = new MultiSessionClient('user_123');
await client.connect();

const adapter = new LangChainAdapter(client);
const tools = await adapter.getTools();

// Use with LangChain agent
const agent = createReactAgent({
  llm,
  tools,
  // ...
});
```

## Configuration

The `LangChainAdapter` supports simplified error messages, which can be useful for LLMs to better understand failures:

```typescript
const adapter = new LangChainAdapter(client, {
  simplifyErrors: true  // Returns error.message instead of full error object
});
```

## API Reference

See the [LangChainAdapter API Reference](/api-reference/server#adapters) for more details.
