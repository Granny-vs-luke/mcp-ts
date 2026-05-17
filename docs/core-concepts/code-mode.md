---
title: "Code Mode"
sidebarTitle: "Code Mode"
description: "Run LLM-generated JavaScript in a V8 sandbox to orchestrate multi-step MCP tool calls, loops, and data transformations without leaving the agent loop."
icon: "code"
---

**Code Mode** is a sandboxed execution engine for MCP agents. It lets the agent run JavaScript in a V8 isolate to orchestrate multiple tool calls, loops, and data transformations in a single turn.

Instead of chaining tool calls one at a time, the LLM writes a short program that calls your tools as if they were ordinary async functions.

It ships as a standalone package, `@mcp-ts/code-mode`, with zero hard dependencies on the rest of the SDK.

## When to use it

Use Code Mode when your agent needs to:

- Run multi-step workflows that combine several tool calls with logic between them.
- Filter, map, or reduce tool outputs without sending large intermediate results back to the model.
- Keep the LLM context small by letting a single tool call drive many underlying operations.
- Expose a large tool catalog to the model through a search-and-call pattern instead of static schemas.

If you only need to call one tool at a time, the standard adapter flow is simpler. Reach for Code Mode when the alternative is several brittle, round-tripped tool calls.

## How it works

Code Mode wraps your tool sources in a V8 isolate created with [`isolated-vm`](https://github.com/laverdet/isolated-vm). Each registered source is exposed inside the sandbox as a namespace, and each tool becomes an async function on that namespace.

A sandboxed script can call tools directly:

```javascript
const prs = await github.list_pull_requests({
  owner: "zonlabs",
  repo: "mcp-ts"
});

return prs.filter(pr => pr.title.includes("leak"));
```

The runtime also generates TypeScript interfaces for every registered tool and exposes them to the model, so the LLM can write type-correct code without inspecting individual schemas.

## Installation

```bash
npm install @mcp-ts/code-mode
```

Running sandboxed code requires the native `isolated-vm` module in your Node server runtime. It is declared as an optional dependency so the package can still build in environments where native modules are unavailable.

```bash
npm install isolated-vm
```

<Note>
  Code Mode requires a Node.js server. It does not run in the browser or in edge runtimes that lack native module support.
</Note>

## Quick start

### 1. Define a tool source

A tool source is anything that can list and call tools. The simplest version is a plain object:

```typescript
const githubSource = {
  id: "github",
  async listTools() {
    return {
      tools: [
        {
          name: "list_pull_requests",
          description: "List open pull requests for a repository.",
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
    };
  },
  async callTool(name, args) {
    if (name === "list_pull_requests") {
      return [{ id: 1, title: "Fix memory leak", state: "open" }];
    }
    throw new Error(`Tool ${name} not found`);
  }
};
```

You can also wrap an existing MCP client as a source. See [Tool Router](/core-concepts/tool-router) for the same pattern.

### 2. Create the runtime

```typescript
import { createCodeModeRuntime } from "@mcp-ts/code-mode";

const runtime = await createCodeModeRuntime({
  sources: [githubSource],
  limits: {
    timeoutMs: 5000,
    memoryLimitMb: 64,
    maxToolCalls: 10
  }
});
```

### 3. Run sandboxed code

```typescript
const result = await runtime.run(
  `
  const prs = await github.list_pull_requests({
    owner: input.owner,
    repo: input.repo
  });

  return prs.filter(pr => pr.title.includes("leak"));
  `,
  { owner: "zonlabs", repo: "mcp-ts" }
);

console.log(result.value);
// [{ id: 1, title: "Fix memory leak", state: "open" }]
```

The second argument to `runtime.run` is serialized and exposed inside the sandbox as the global `input`.

## Sandbox globals

Scripts running inside the sandbox have access to:

| Global | Description |
| :-- | :-- |
| `input` | The serializable payload passed from the host. |
| `callTool(sourceId, toolName, args)` | Directly invoke a tool by id. |
| `searchTools(query, limit?)` | Search registered tool descriptions. |
| `console` | `log`, `info`, `warn`, `error` redirected to host logs. |
| `<sourceId>.<toolName>(args)` | Namespaced helpers generated from your sources. |

<Warning>
  The sandbox does not expose Node.js globals such as `process`, `fs`, or `require`. There is no network or filesystem access except through the tools you register.
</Warning>

## Configuring limits

Every runtime accepts a `limits` object that caps how much the script can do:

| Option | Default | Description |
| :-- | :-- | :-- |
| `timeoutMs` | `5000` | Maximum wall-clock time per `run` call. |
| `memoryLimitMb` | `64` | Memory ceiling for the V8 isolate. |
| `maxToolCalls` | `25` | Total tool invocations allowed per run. |

Pick values that match the workloads you expect. Tight limits keep accidental loops cheap; looser limits give agents room to assemble larger results.

## AI SDK integration

To let an LLM drive Code Mode through the Vercel AI SDK, wrap the runtime with `createCodemodeAITools`:

```typescript
import { createCodeModeRuntime, createCodemodeAITools } from "@mcp-ts/code-mode";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const runtime = await createCodeModeRuntime({ sources: [githubSource] });
const aiTools = await createCodemodeAITools(runtime);

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: aiTools,
  prompt: "Find any open memory leak pull requests on the github source."
});
```

The model sees a small set of meta-tools (`codemode_search_tools`, `codemode_list_sources`, `codemode_tools_info`, and `call_tool_chain`) and uses them to discover sources and execute scripts.

## Exposing Code Mode as an MCP server

You can also wrap the runtime as a standalone MCP server, so any MCP client can use Code Mode as if it were a single tool:

```typescript
import { createCodeModeMcpServer } from "@mcp-ts/code-mode/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = await createCodeModeMcpServer({
  sources: [githubSource],
  limits: {
    timeoutMs: 10000,
    memoryLimitMb: 128
  }
});

await server.connect(new StdioServerTransport());
```

## Result shape

Every call to `runtime.run` returns a structured result:

```typescript
interface CodeModeResult {
  value?: unknown;              // The value returned by your script
  logs: CodeModeLogEntry[];     // Captured console output
  toolCalls: CodeModeToolCall[]; // Trace of tools called during the run
  durationMs: number;           // Execution duration in milliseconds
  error?: CodeModeError;        // Set if the sandbox raised an error
}
```

Use `toolCalls` to build audit trails, surface progress in your UI, or feed traces back into the model for follow-up reasoning.
