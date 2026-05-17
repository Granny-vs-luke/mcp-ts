import assert from "node:assert/strict";
import test from "node:test";

const hasIsolatedVm = await import("isolated-vm").then(
  () => true,
  () => false
);

/**
 * Creates a fake ToolSource for testing.
 */
function fakeSource(id = "github", tools = undefined) {
  const calls = [];
  return {
    calls,
    source: {
      id,
      name: id,
      listTools: async () => ({
        tools: tools ?? [
          {
            name: "get_issue",
            description: "Get a GitHub issue by number",
            inputSchema: {
              type: "object",
              properties: {
                issue_number: { type: "number", description: "Issue number" }
              },
              required: ["issue_number"]
            }
          },
          {
            name: "create_issue",
            description: "Create a new GitHub issue",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Issue title" },
                body: { type: "string", description: "Issue body" }
              },
              required: ["title"]
            }
          }
        ]
      }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { name, args };
      }
    }
  };
}

function fakeExaSource() {
  const calls = [];
  return {
    calls,
    source: {
      id: "exa",
      name: "exa",
      listTools: async () => ({
        tools: [
          {
            name: "web_search",
            description: "Search the web for information",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" }
              },
              required: ["query"]
            }
          }
        ]
      }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { results: [{ title: "Result 1", url: "https://example.com" }] };
      }
    }
  };
}

// -----------------------------------------------------------------------
// Test 1: Namespace bridging — source.tool(args) works WITHOUT await
// -----------------------------------------------------------------------
test("namespace bridging: github.get_issue(args) works without await", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { calls, source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    const issue = github.get_issue({ issue_number: 42 });
    return { issue, found: true };
  `);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.issue, { name: "get_issue", args: { issue_number: 42 } });
  assert.equal(result.value.found, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_issue");
});

// -----------------------------------------------------------------------
// Test 2: Namespace bridging with await also works
// -----------------------------------------------------------------------
test("namespace bridging: await github.get_issue(args) also works", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { calls, source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    const issue = await github.get_issue({ issue_number: 99 });
    return issue;
  `);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { name: "get_issue", args: { issue_number: 99 } });
  assert.equal(calls.length, 1);
});

// -----------------------------------------------------------------------
// Test 3: Legacy callTool(sourceId, toolName, args) escape hatch
// -----------------------------------------------------------------------
test("callTool() escape hatch works", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { calls, source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    const issue = callTool("github", "get_issue", { issue_number: 7 });
    return issue;
  `);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { name: "get_issue", args: { issue_number: 7 } });
  assert.equal(calls.length, 1);
});

// -----------------------------------------------------------------------
// Test 4: searchTools() inside sandbox
// -----------------------------------------------------------------------
test("searchTools() inside sandbox returns results", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    const tools = searchTools("issue");
    return tools.map(t => ({ sourceId: t.sourceId, toolName: t.toolName }));
  `);

  assert.equal(result.error, undefined);
  assert.ok(Array.isArray(result.value));
  assert.ok(result.value.length > 0);
  assert.equal(result.value[0].sourceId, "github");
});

// -----------------------------------------------------------------------
// Test 5: __interfaces contains TypeScript definitions
// -----------------------------------------------------------------------
test("__interfaces contains TypeScript definitions", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    return __interfaces;
  `);

  assert.equal(result.error, undefined);
  assert.ok(typeof result.value === "string");
  assert.ok(result.value.includes("namespace github"));
  assert.ok(result.value.includes("get_issueInput"));
  assert.ok(result.value.includes("issue_number"));
});

// -----------------------------------------------------------------------
// Test 6: __getToolInterface() returns specific tool interface
// -----------------------------------------------------------------------
test("__getToolInterface() returns specific tool interface", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    const iface = __getToolInterface("github.get_issue");
    return iface;
  `);

  assert.equal(result.error, undefined);
  assert.ok(typeof result.value === "string");
  assert.ok(result.value.includes("github.get_issue(args)"));
});

// -----------------------------------------------------------------------
// Test 7: Multi-source namespace isolation
// -----------------------------------------------------------------------
test("multi-source: github.get_issue() vs exa.web_search()", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const github = fakeSource();
  const exa = fakeExaSource();
  const runtime = await createCodeModeRuntime({ sources: [github.source, exa.source] });

  const result = await runtime.run(`
    const issue = github.get_issue({ issue_number: 1 });
    const search = exa.web_search({ query: "hello world" });
    return { issue, search };
  `);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.issue, { name: "get_issue", args: { issue_number: 1 } });
  assert.deepEqual(result.value.search, { results: [{ title: "Result 1", url: "https://example.com" }] });
  assert.equal(github.calls.length, 1);
  assert.equal(exa.calls.length, 1);
});

// -----------------------------------------------------------------------
// Test 8: Console output capture
// -----------------------------------------------------------------------
test("console output is captured", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    console.log("hello");
    console.warn("caution");
    console.error("fail");
    return "done";
  `);

  assert.equal(result.error, undefined);
  assert.equal(result.value, "done");
  assert.equal(result.logs.length, 3);
  assert.equal(result.logs[0].level, "log");
  assert.equal(result.logs[1].level, "warn");
  assert.equal(result.logs[2].level, "error");
});

// -----------------------------------------------------------------------
// Test 9: Tool calls are tracked
// -----------------------------------------------------------------------
test("tool calls are tracked in result", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    github.get_issue({ issue_number: 1 });
    github.create_issue({ title: "test" });
    return "done";
  `);

  assert.equal(result.error, undefined);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].toolName, "get_issue");
  assert.equal(result.toolCalls[0].ok, true);
  assert.equal(result.toolCalls[1].toolName, "create_issue");
  assert.equal(result.toolCalls[1].ok, true);
});

// -----------------------------------------------------------------------
// Test 10: Input passthrough
// -----------------------------------------------------------------------
test("input is accessible in sandbox", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const { source } = fakeSource();
  const runtime = await createCodeModeRuntime({ sources: [source] });

  const result = await runtime.run(`
    return { doubled: input.value * 2 };
  `, { value: 21 });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { doubled: 42 });
});

// -----------------------------------------------------------------------
// Test 11: Host-side searchTools and listSources
// -----------------------------------------------------------------------
test("runtime.searchTools() and runtime.listSources() work", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const github = fakeSource();
  const exa = fakeExaSource();
  const runtime = await createCodeModeRuntime({ sources: [github.source, exa.source] });

  const searchResults = await runtime.searchTools("search web");
  assert.ok(searchResults.length > 0);
  assert.equal(searchResults[0].toolName, "web_search");

  const sources = runtime.listSources();
  assert.equal(sources.length, 2);
  assert.ok(sources.some(s => s.sourceId === "github"));
  assert.ok(sources.some(s => s.sourceId === "exa"));
});
