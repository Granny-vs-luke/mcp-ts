# @mcp-ts/codemode

Sandboxed execution engine for Model Context Protocol (MCP) tools.

`@mcp-ts/codemode` lets an agent run JavaScript programs in a V8 sandbox to orchestrate multiple tool calls, loops, and data transformations.

---

## Features

- **V8 Sandboxing**: Uses `isolated-vm` to isolate memory and execution.
- **Namespace Bridging**: Exposes connected tool servers as callable JavaScript functions (e.g., `await github.list_pull_requests(...)`).
- **TypeScript Interfaces**: Generates TypeScript type definitions for registered tools.
- **Adapters**: Built-in support for Vercel AI SDK and native MCP server tools.
- **Optional Native Dependency**: `isolated-vm` is optional at install time so the package builds in any environment.

---

## Installation

```bash
npm install @mcp-ts/codemode
```

> [!NOTE]
> Running sandboxed code requires `isolated-vm` in your Node server runtime:
> ```bash
> npm install isolated-vm
> ```

---

## Quick Start

### 1. Initialize the Runtime

```typescript
import { createCodeModeRuntime } from "@mcp-ts/codemode";

// Define a tool server
const githubServer = {
  serverId: "github",
  serverName: "GitHub",
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
              repo: { type: "string" }
            },
            required: ["owner", "repo"]
          }
        }
      ]
    };
  },
  async callTool(name: string, args: any) {
    if (name === "list_pull_requests") {
      return [{ id: 1, title: "Fix memory leak", state: "open" }];
    }
    throw new Error(`Tool ${name} not found`);
  }
};

// Create the runtime
const runtime = await createCodeModeRuntime({
  servers: [githubServer],
  limits: {
    timeoutMs: 5000,
    memoryLimitMb: 64,
    maxToolCalls: 10
  }
});
```

### 2. Run Sandboxed Code

```typescript
const result = await runtime.run(
  `
  const prs = await github.list_pull_requests({
    owner: input.owner,
    repo: input.repo
  });

  return prs.filter(pr => pr.title.includes("leak"));
  `,
  { owner: "zonlabs", repo: "mcp-ts" } // Exposed as global `input`
);

console.log(result.value);
// Output: [{ id: 1, title: "Fix memory leak", state: "open" }]
```

---

## Sandbox API

Scripts running inside the sandbox have access to:

- `input`: The serializable input payload passed from the host.
- `callTool(serverId, toolName, args)`: Directly invoke a tool and receive the normalized result.
- `callToolRaw(serverId, toolName, args)`: Directly invoke a tool and receive the raw MCP envelope when available.
- `searchTools(query, limit?)`: Search descriptions of registered tools.
- `console`: Standard console logging (`log`, `info`, `warn`, `error`) redirected to host-managed logs.
- **Hierarchical Namespaces**: E.g. `github.list_pull_requests(args)` generated dynamically from your registered sources.

> [!WARNING]
> The sandbox does not have access to Node.js system globals (e.g. `process`, `fs`), HTTP network libraries, or Node module loading (`require`, `import`).

---

## AI SDK Integration

Expose sandboxed tools to LLMs using the Vercel AI SDK:

```typescript
import { createCodemodeAITools } from "@mcp-ts/codemode";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const aiTools = await createCodemodeAITools(runtime);

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: aiTools,
  prompt: "Find any open memory leak pull requests on the github source."
});
```

---

## MCP Server Wrapper

Expose the `codemode` engine as an MCP server:

```typescript
import { createCodeModeMcpServer } from "@mcp-ts/codemode/server";

const server = await createCodeModeMcpServer({
  servers: [githubServer],
  limits: {
    timeoutMs: 10000,
    memoryLimitMb: 128
  }
});

await server.connect(new StdioServerTransport());
```

---

## Result Schema

```typescript
interface CodeModeResult {
  value?: unknown;            // The value returned by your sandboxed script
  logs: CodeModeLogEntry[];   // Redirected console outputs
  toolCalls: CodeModeToolCall[]; // Trace of tools called during run
  durationMs: number;         // Execution duration
  error?: CodeModeError;      // Sandbox error if one occurred
}
```

---

## License

MIT License.
