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
import { MultiSessionClient, E2BSandboxRuntime } from "@mcp-ts/sdk/server";
import { ProgrammaticToolRunner } from "@mcp-ts/sdk/shared";
import { AIAdapter } from "@mcp-ts/sdk/adapters/ai";

const client = new MultiSessionClient("user_123");
await client.connect();

const programmaticToolRunner = new ProgrammaticToolRunner(client, {
  runtime: new E2BSandboxRuntime({
    bridgeUrl: "https://your-app.example.com/api/mcp/tool-bridge",
    bridgeToken: process.env.MCP_TOOL_BRIDGE_TOKEN,
  }),
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

## Sandbox Runtimes

`mcp-ts` includes multiple runtime adapters:

- `E2BSandboxRuntime`: runs code in an E2B cloud sandbox. Install `@e2b/code-interpreter` to use it.
- `VercelSandboxRuntime`: runs code in a Vercel Sandbox Firecracker microVM. Install `@vercel/sandbox` to use it.
- `JavaScriptSandboxRuntime`: runs code in-process with Node `vm`. Use this for tests, demos, and local development only.

External cloud runtimes need a `bridgeUrl` so sandboxed code can call back to your host application for MCP tool execution. The sandbox runs the JavaScript, but the real MCP tools still execute in your server process where credentials and MCP clients live.

```typescript
import { VercelSandboxRuntime } from "@mcp-ts/sdk/server";

const runtime = new VercelSandboxRuntime({
  bridgeUrl: "https://your-app.example.com/api/mcp/tool-bridge",
  bridgeToken: process.env.MCP_TOOL_BRIDGE_TOKEN,
  createOptions: {
    runtime: "node24",
  },
});
```

The bridge endpoint should authenticate the token, enforce the same `allowedTools` policy, execute the requested MCP tool, and return:

```typescript
// app/api/mcp/tool-bridge/route.ts
import { MultiSessionClient, ProgrammaticToolBridge } from "@mcp-ts/sdk/server";

export async function POST(request: Request) {
  const client = new MultiSessionClient("user_123");
  await client.connect();

  const bridge = new ProgrammaticToolBridge(client, {
    bridgeToken: process.env.MCP_TOOL_BRIDGE_TOKEN,
    allowedTools: ["list_users", "get_user_expenses"],
  });

  try {
    return await bridge.handleRequest(request);
  } finally {
    await client.disconnect();
  }
}
```

Successful bridge responses look like:

```json
{
  "result": { "ok": true }
}
```

For errors:

```json
{
  "isError": true,
  "error": "Tool is not allowed"
}
```

`JavaScriptSandboxRuntime` exposes only the injected `tools` object and a captured `console`. It does not expose `process`, `require`, `fetch`, filesystem access, environment variables, or package imports, but it is still not a production-grade boundary for arbitrary hostile code. Use E2B, Vercel Sandbox, or another external `SandboxRuntime` implementation for untrusted code.
