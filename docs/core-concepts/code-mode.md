---
title: "Code Mode"
sidebarTitle: "Overview"
description: "Run agent-generated JavaScript in a V8 sandbox with @mcp-ts/codemode to orchestrate multi-step MCP tool workflows without exposing every tool schema to the LLM."
icon: "code"
---

**Code Mode** lets an agent write and execute JavaScript inside a sandboxed V8 isolate to orchestrate multiple MCP tool calls, loops, and data transformations in a single turn.

Instead of asking the LLM to chain tool calls one at a time, you give it a tiny sandbox where it can write a short program that calls tools directly as namespaced functions — for example, `github.list_pull_requests({ owner, repo })`. The runtime executes the script in isolation, captures logs and tool calls, and returns the final value.

Code Mode is published as the standalone package [`@mcp-ts/codemode`](https://www.npmjs.com/package/@mcp-ts/codemode).

## When to use Code Mode

Use Code Mode when:

- A task requires **chaining several tool calls** (search → filter → fetch details → summarize).
- You want to **reduce round-trips** between the model and your server.
- You need **deterministic logic** (filtering, sorting, aggregations) that the model should not have to reason about token-by-token.
- You have many tools and want the LLM to **search and call them on demand** rather than seeing every schema upfront.

Use the [Tool Router](/core-concepts/tool-router) without Code Mode when you only need on-demand tool discovery and a single-tool call per turn.

## How it works

<Steps>
  <Step title="Register sources">
    You provide one or more `ToolSource` objects (or wrap existing MCP clients with `mcpSources`). Each source exposes `listTools` and `callTool`.
  </Step>
  <Step title="Generate a namespace">
    The runtime indexes tools and exposes each source as a JavaScript namespace inside the sandbox. TypeScript-style interfaces are also injected so the LLM can write well-typed calls.
  </Step>
  <Step title="Execute sandboxed code">
    The LLM emits a code string. The runtime runs it inside an `isolated-vm` V8 isolate with memory, time, and tool-call limits applied.
  </Step>
  <Step title="Return a result">
    The runtime returns the script's return value along with `logs`, `toolCalls`, and `durationMs` for observability.
  </Step>
</Steps>

## Installation

```bash npm2yarn
npm install @mcp-ts/codemode
```

Running sandboxed code requires the native `isolated-vm` package in your Node server runtime. It is declared as an optional dependency so the package builds in any environment:

```bash npm2yarn
npm install isolated-vm
```

<Warning>
  `isolated-vm` requires a native build toolchain and a Node.js server runtime. It is not supported in edge runtimes or the browser.
</Warning>

## Quick start

### 1. Define a tool source

```typescript
import { createCodeModeRuntime } from "@mcp-ts/codemode";

const githubSource = {
  id: "github",
  name: "GitHub",
  async listTools() {
    return {
      tools: [
        {
          name: "list_pull_requests",
          description: "List open pull requests for a repository",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
            },
            required: ["owner", "repo"],
          },
        },
      ],
    };
  },
  async callTool(name, args) {
    if (name === "list_pull_requests") {
      return [{ id: 1, title: "Fix memory leak", state: "open" }];
    }
    throw new Error(`Tool ${name} not found`);
  },
};
```

### 2. Create the runtime

```typescript
const runtime = await createCodeModeRuntime({
  sources: [githubSource],
  limits: {
    timeoutMs: 5000,
    memoryLimitMb: 64,
    maxToolCalls: 10,
  },
});
```

### 3. Run sandboxed code

```typescript
const result = await runtime.run(
  `
  const prs = await github.list_pull_requests({
    owner: input.owner,
    repo: input.repo,
  });

  return prs.filter((pr) => pr.title.includes("leak"));
  `,
  { owner: "zonlabs", repo: "mcp-ts" }
);

console.log(result.value);
// [{ id: 1, title: "Fix memory leak", state: "open" }]
```

## Sandbox API

Scripts running inside the sandbox have access to:

| Global | Description |
| :-- | :-- |
| `input` | The serializable payload you pass as the second argument to `runtime.run()`. |
| `<sourceId>.<toolName>(args)` | Each registered source becomes a namespace with one function per tool. Calls look synchronous but bridge to the host. |
| `callTool(sourceId, toolName, args)` | Lower-level escape hatch for invoking a tool directly. |
| `searchTools(query, limit?)` | Search the indexed tools by description without leaving the sandbox. |
| `console` | `log`, `info`, `warn`, and `error` are captured and returned in `result.logs`. |

<Warning>
  The sandbox has no access to Node globals (`process`, `fs`), network libraries, or module loading (`require`, `import`). This is intentional — Code Mode is for tool orchestration, not arbitrary code execution.
</Warning>

## Configuration

Pass `limits` to `createCodeModeRuntime` to bound resource usage:

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `timeoutMs` | `number` | `5000` | Maximum wall-clock time per `run()` call. |
| `memoryLimitMb` | `number` | `64` | Memory ceiling for the isolate. |
| `maxToolCalls` | `number` | `20` | Maximum tool calls per script. |
| `maxConcurrentToolCalls` | `number` | `5` | Maximum tools that can run in parallel. |
| `maxResultBytes` | `number` | `1_000_000` | Caps the size of the returned `value`. |
| `maxLogEntries` | `number` | `200` | Caps the number of captured `console` entries. |

## Result schema

Every call to `runtime.run()` returns a `CodeModeResult`:

```typescript
interface CodeModeResult {
  value?: unknown;            // Value returned by the sandboxed script
  logs: CodeModeLogEntry[];   // Captured console output
  toolCalls: CodeModeToolCall[]; // Trace of tools called during the run
  durationMs: number;         // Total execution time
  error?: CodeModeError;      // Set when the sandbox throws or hits a limit
}
```

Errors set a `code` of `SANDBOX_ERROR`, `TIMEOUT`, `TOOL_NOT_FOUND`, `TOOL_EXECUTION_FAILED`, or `RESULT_TOO_LARGE`.

## Vercel AI SDK integration

`createCodemodeAITools` exposes the runtime to the Vercel AI SDK as four meta-tools:

- `codemode_search_tools` — find tools by natural language description.
- `codemode_list_sources` — list connected sources and tool counts.
- `codemode_tools_info` — fetch TypeScript interfaces for specific tools before using them.
- `call_tool_chain` — execute a sandboxed script.

```typescript
import { createCodeModeRuntime, createCodemodeAITools, mcpSources } from "@mcp-ts/codemode";
import { MultiSessionClient } from "@mcp-ts/sdk/server";
import { ToolLoopAgent, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";

const client = new MultiSessionClient(userId);
await client.connect();

const runtime = await createCodeModeRuntime({
  sources: mcpSources(client),
  limits: { timeoutMs: 30_000, maxToolCalls: 50 },
});

const tools = await createCodemodeAITools(runtime);

const agent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  tools,
  stopWhen: stepCountIs(20),
});
```

The agent first calls `codemode_search_tools` to find relevant tools, then `codemode_tools_info` to pull in their TypeScript interfaces, then `call_tool_chain` to run a short script that combines them.

## MCP server wrapper

You can also expose Code Mode itself as an MCP server, so any MCP-compatible client can call the runtime:

```typescript
import { createCodeModeMcpServer } from "@mcp-ts/codemode/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = await createCodeModeMcpServer({
  sources: [githubSource],
  limits: { timeoutMs: 10_000, memoryLimitMb: 128 },
});

await server.connect(new StdioServerTransport());
```

## Next steps

- [Tool Router](/core-concepts/tool-router) — on-demand tool discovery without sandboxed code execution.
- [Meta Tools](/core-concepts/meta-tools) — reference for the meta-tools that ship with the router.
