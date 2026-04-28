---
title: "Programmatic Tool Calling"
sidebarTitle: "Programmatic Tool Calling"
description: "Run sandboxed JavaScript that calls MCP tools programmatically across providers."
---

Programmatic tool calling lets an agent run a small sandboxed JavaScript program where MCP tools are injected as async functions.

Use it when a task needs loops, branching, parallel calls, filtering, aggregation, or large intermediate results that should not be sent back into the model context after every tool call.

The exposed provider-facing tool is:

```txt
mcp_run_code
```

Because `mcp_run_code` is just a normal tool definition, it works across adapters such as AI SDK, LangChain, Mastra, and AG-UI. It does not require Claude-native `allowed_callers`.

## Setup

```typescript
import { MultiSessionClient, JavaScriptSandboxRuntime } from "@mcp-ts/sdk/server";
import { ProgrammaticToolRunner } from "@mcp-ts/sdk/shared";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";

const client = new MultiSessionClient("user_123");
await client.connect();

const programmaticToolRunner = new ProgrammaticToolRunner(client, {
  runtime: new JavaScriptSandboxRuntime(),
  allowedTools: ["list_users", "get_user_expenses"],
  maxToolCalls: 50,
  maxParallelToolCalls: 10,
  timeoutMs: 30_000,
  maxFinalOutputBytes: 20_000,
});

const tools = await AIAdapter.getTools(client, {
  programmaticToolRunner,
});
```

The model can then call `mcp_run_code` with JavaScript like:

```typescript
const users = await tools.list_users({});
const expenses = await Promise.all(
  users.map((user) => tools.get_user_expenses({ userId: user.id }))
);

return expenses
  .filter((expense) => expense.total > 1000)
  .map((expense) => ({ userId: expense.userId, total: expense.total }));
```

## Allowed Tools

`allowedTools` is the provider-neutral equivalent of a code-calling allowlist. It controls which MCP tools are visible inside the sandbox.

You can configure a broad policy on the runner and optionally narrow it per `mcp_run_code` call:

```json
{
  "code": "return await tools.get_user_expenses({ userId: 'u_123' })",
  "allowedTools": ["get_user_expenses"]
}
```

Per-run `allowedTools` can only narrow the runner policy. It cannot grant access to tools that the runner did not allow.

## Runtime Limits

The runner enforces:

- `maxToolCalls`
- `maxParallelToolCalls`
- `timeoutMs`
- `maxToolResultBytes`
- `maxFinalOutputBytes`

Each run also returns a trace with the executed tool names, server IDs, duration, success state, and final output truncation state.

## Sandbox Notes

`JavaScriptSandboxRuntime` exposes only the injected `tools` object and a captured `console`. It does not expose `process`, `require`, `fetch`, filesystem access, environment variables, or package imports.

The initial runtime is intended for controlled model-generated code. If you need to execute arbitrary untrusted user code, use a stronger external isolation backend by implementing the `SandboxRuntime` interface.
