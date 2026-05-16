# @mcp-ts/codemode

Sandboxed code execution for MCP and agent tools.

`@mcp-ts/codemode` lets an agent run a small async JavaScript program that can search and call tools through `@mcp-ts/toolrouter`. It is designed for multi-step tool workflows: search for the right tools, call several tools, transform results, loop over data, and return one structured answer.

Codemode uses `isolated-vm` for sandboxing. The dependency is optional at install time so apps can install and build without native toolchain failures, but sandbox execution requires `isolated-vm` to be installed on the server runtime.

## When To Use It

Use Codemode when direct tool calls become awkward:

- The agent needs to call several tools in sequence.
- Tool results need filtering, joining, grouping, or reshaping.
- The agent needs loops or conditional logic around tool calls.
- You want a single `codemode_run` MCP tool instead of exposing many tools directly.
- You already use `@mcp-ts/toolrouter` for discovery and schema loading.

Use `@mcp-ts/toolrouter` alone when the model should simply search, fetch one schema, and call one tool at a time.

## Installation

```bash
npm install @mcp-ts/codemode @mcp-ts/toolrouter
```

To execute sandboxed code, install `isolated-vm` in the runtime app:

```bash
npm install isolated-vm@latest
```

`isolated-vm` is a native Node.js addon. If it cannot install on your machine, Codemode can still be imported and built, but `runtime.run(...)` will return an error when it tries to load the sandbox engine.

## Runtime Requirements

- Node.js server runtime only.
- Do not run Codemode in a browser or Edge runtime.
- `isolated-vm` must be installed where `runtime.run(...)` executes.
- On Windows, native builds may require Visual Studio Build Tools with the C++ workload.

For Next.js route handlers or server actions, force Node runtime:

```ts
export const runtime = "nodejs";
```

## Windows Install Notes

The cleanest path is usually Node 22 LTS plus the latest `isolated-vm`:

```powershell
node -v
npm install isolated-vm@latest
npm ls isolated-vm
```

The success condition is that `npm ls isolated-vm` shows an installed version.

If npm falls back to native compilation and fails with `missing any VC++ toolset`, install or modify Visual Studio Build Tools:

- Install **Visual Studio Build Tools 2022**.
- Enable **Desktop development with C++**.
- Include an MSVC C++ toolset and Windows 10/11 SDK.
- Run `npm config set msvs_version 2022`.
- Reinstall `isolated-vm`.

## Basic Usage

Create a ToolRouter first, then pass it to Codemode.

```ts
import { createToolRouter, mcpSource } from "@mcp-ts/toolrouter";
import { createCodeModeRuntime } from "@mcp-ts/codemode";

const router = await createToolRouter({
  sources: [
    mcpSource("github", githubMcpClient),
    mcpSource("linear", linearMcpClient)
  ],
  policy: {
    allowTools: ["github.*", "linear.*"],
    denyDestructiveTools: true
  }
});

const runtime = createCodeModeRuntime({
  router,
  limits: {
    timeoutMs: 10_000,
    memoryLimitMb: 64,
    maxToolCalls: 20,
    maxConcurrentToolCalls: 3
  }
});

const result = await runtime.run(
  `
  const matches = await searchTools("github open pull requests");

  const pullRequests = await callTool("github", "list_pull_requests", {
    owner: input.owner,
    repo: input.repo,
    state: "open"
  });

  return {
    matches,
    pullRequests
  };
  `,
  {
    owner: "zonlabs",
    repo: "mcp-ts"
  }
);

if (result.error) {
  throw new Error(result.error.message);
}

console.log(result.value);
```

## Sandbox API

Sandboxed code receives a narrow API:

- `input` - the serializable input passed to `runtime.run`.
- `searchTools(query, limit?)` - searches ToolRouter without returning full schemas.
- `callTool(sourceId, toolName, args?)` - calls one routed tool.
- `console.log`, `console.info`, `console.warn`, `console.error` - captured into `result.logs`.

The sandbox does not receive Node globals such as `process`, `fs`, `require`, package imports, or direct network access.

## Result Shape

```ts
type CodeModeResult = {
  value?: unknown;
  logs: Array<{
    level: "log" | "info" | "warn" | "error";
    args: unknown[];
  }>;
  toolCalls: Array<{
    id: string;
    sourceId: string;
    toolName: string;
    args: unknown;
    startedAt: number;
    durationMs: number;
    ok: boolean;
    error?: string;
  }>;
  durationMs: number;
  error?: {
    code:
      | "SANDBOX_ERROR"
      | "POLICY_DENIED"
      | "TIMEOUT"
      | "TOOL_NOT_FOUND"
      | "TOOL_EXECUTION_FAILED"
      | "RESULT_TOO_LARGE";
    message: string;
  };
};
```

## Limits

Limits are enforced by the runtime and host bridge.

```ts
const runtime = createCodeModeRuntime({
  router,
  limits: {
    timeoutMs: 10_000,
    memoryLimitMb: 64,
    maxToolCalls: 20,
    maxConcurrentToolCalls: 3,
    maxResultBytes: 1024 * 1024,
    maxLogEntries: 100
  }
});
```

Default limits:

- `timeoutMs`: `10000`
- `memoryLimitMb`: `64`
- `maxToolCalls`: `20`
- `maxConcurrentToolCalls`: `3`
- `maxResultBytes`: `1048576`
- `maxLogEntries`: `100`

## MCP Server Wrapper

Use `createCodeModeMcpServer` to expose a `codemode_run` MCP tool.

```ts
import { createCodeModeMcpServer } from "@mcp-ts/codemode/server";

const server = createCodeModeMcpServer({
  router,
  limits: {
    timeoutMs: 10_000,
    memoryLimitMb: 64
  }
});
```

The MCP tool accepts:

- `code` - async JavaScript body. Use `return` for the final value.
- `input` - optional serializable input exposed as `input`.
- `timeoutMs` - optional per-run timeout.

Example MCP arguments:

```json
{
  "code": "const prs = await callTool('github', 'list_pull_requests', { owner: input.owner, repo: input.repo }); return prs;",
  "input": {
    "owner": "zonlabs",
    "repo": "mcp-ts"
  },
  "timeoutMs": 10000
}
```

## Next.js Example Pattern

Codemode must run on the server.

```ts
export const runtime = "nodejs";

import { createToolRouter, mcpSource } from "@mcp-ts/toolrouter";
import { createCodeModeRuntime } from "@mcp-ts/codemode";

export async function POST(request: Request) {
  const body = await request.json();

  const router = await createToolRouter({
    sources: [mcpSource("github", githubMcpClient)]
  });

  const codemode = createCodeModeRuntime({ router });
  const result = await codemode.run(body.code, body.input);

  return Response.json(result, {
    status: result.error ? 400 : 200
  });
}
```

Do not import Codemode from React Client Components.

## Working With ToolRouter

Codemode delegates discovery and execution to `@mcp-ts/toolrouter`.

Recommended agent flow:

1. Use ToolRouter meta-tools to search for relevant tools.
2. Fetch schemas for only the tools the agent needs.
3. Write `codemode_run` code using `searchTools` and `callTool`.
4. Let Codemode execute the multi-step workflow.

This keeps Codemode focused on safe code execution and keeps tool indexing/search behavior in one package.

## Troubleshooting

### `isolated-vm` is missing

If `npm ls isolated-vm` shows `(empty)`, sandbox execution will not work.

Install it in the runtime app:

```bash
npm install isolated-vm@latest
```

### `missing any VC++ toolset`

Install Visual Studio Build Tools 2022 with **Desktop development with C++**, then run:

```powershell
npm config set msvs_version 2022
npm install isolated-vm@latest
```

### Works in build, fails at runtime

That usually means `isolated-vm` was not installed in the app that is running the server. Install it where `runtime.run(...)` executes, not only in this package directory.

### Next.js Edge runtime error

Codemode cannot run in Edge. Add:

```ts
export const runtime = "nodejs";
```

## Development

```bash
cd packages/codemode
npm run build
npm run type-check
npm test
```

If `isolated-vm` is not installed locally, sandbox execution tests are skipped. Build and type-check should still pass.
