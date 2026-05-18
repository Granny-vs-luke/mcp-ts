import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolRouter,
  createToolSource
} from "../dist/index.js";

function fakeSource(id, tools) {
  const calls = [];
  return {
    calls,
    source: createToolSource({
      id,
      name: id,
      listTools: async () => ({ tools }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { source: id, name, args };
      }
    })
  };
}

test("searches tools without exposing full schemas", async () => {
  const github = fakeSource("github", [
    {
      name: "list_pull_requests",
      description: "List GitHub pull requests for a repository",
      inputSchema: { type: "object", properties: { repo: { type: "string" } } }
    },
    {
      name: "create_issue",
      description: "Create a GitHub issue",
      annotations: { destructiveHint: true },
      inputSchema: { type: "object", properties: { title: { type: "string" } } }
    }
  ]);
  const slack = fakeSource("slack", [
    {
      name: "send_message",
      description: "Send a Slack channel message",
      inputSchema: { type: "object", properties: { channel: { type: "string" } } }
    }
  ]);

  const router = await createToolRouter({ sources: [github.source, slack.source] });
  const results = await router.searchTools({ query: "github pull requests" });

  assert.equal(results[0].toolId, "github.list_pull_requests");
  assert.equal(results[0].serverId, "github");
  assert.equal(results[0].toolName, "list_pull_requests");
  assert.equal(results[0].inputSchema, undefined);
});

test("returns schemas and proxies calls to the selected server", async () => {
  const github = fakeSource("github", [
    {
      name: "get_issue",
      description: "Get GitHub issue",
      inputSchema: { type: "object", required: ["issue_number"] }
    }
  ]);

  const router = await createToolRouter({ sources: [github.source] });
  const [schema] = router.getToolSchemas({ toolIds: ["github.get_issue"] });
  const result = await router.callTool({
    toolId: "github.get_issue",
    args: { issue_number: 7 }
  });

  assert.equal(schema.toolId, "github.get_issue");
  assert.deepEqual(schema.inputSchema, { type: "object", required: ["issue_number"] });
  assert.deepEqual(result, {
    source: "github",
    name: "get_issue",
    args: { issue_number: 7 }
  });
  assert.deepEqual(github.calls, [{ name: "get_issue", args: { issue_number: 7 } }]);
});

test("exposes meta tools for search, schema lookup, and proxy execution", async () => {
  const github = fakeSource("github", [
    {
      name: "list_pull_requests",
      description: "List GitHub pull requests",
      inputSchema: { type: "object", properties: { state: { type: "string" } } }
    }
  ]);
  const router = await createToolRouter({ sources: [github.source] });
  const metaTools = router.getMetaTools();
  const names = metaTools.map((tool) => tool.name);

  assert.deepEqual(names, [
    "search_tools",
    "list_servers",
    "get_tool_schemas",
    "call_tool"
  ]);

  const search = await router.executeMetaTool("search_tools", {
    query: "pull requests"
  });
  assert.equal(search.isError, false);
  assert.match(search.content[0].text, /list_pull_requests/);
  assert.equal(search.structuredContent, undefined);

  const schema = await router.executeMetaTool("get_tool_schemas", {
    toolIds: ["github.list_pull_requests"]
  });
  assert.equal(schema.isError, false);
  assert.match(schema.content[0].text, /Parameters/);
  assert.equal(schema.structuredContent, undefined);

  const call = await router.executeMetaTool("call_tool", {
    toolId: "github.list_pull_requests",
    args: { state: "open" }
  });
  assert.equal(call.isError, false);
  assert.match(call.content[0].text, /open/);
  assert.equal(call.structuredContent, undefined);
});

test("enforces destructive tool approval policy", async () => {
  const github = fakeSource("github", [
    {
      name: "delete_issue",
      description: "Delete GitHub issue",
      annotations: { destructiveHint: true },
      inputSchema: { type: "object" }
    }
  ]);
  const router = await createToolRouter({
    sources: [github.source],
    policy: { denyDestructiveTools: true }
  });

  await assert.rejects(
    router.callTool({ toolId: "github.delete_issue", args: {} }),
    /Policy denied/
  );
  assert.equal(github.calls.length, 0);
});

test("normalizes server ids consistently during search", async () => {
  const github = fakeSource("GitHub Server", [
    {
      name: "list_pull_requests",
      description: "List GitHub pull requests"
    }
  ]);

  const router = await createToolRouter({ sources: [github.source] });
  const results = await router.searchTools({
    serverId: "GitHub Server",
    query: "pull requests"
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].serverId, "github_server");
});

test("initializes schema lookup when using the async meta-tool path", async () => {
  const github = fakeSource("github", [
    {
      name: "get_issue",
      description: "Get GitHub issue",
      inputSchema: { type: "object", required: ["issue_number"] }
    }
  ]);

  const { ToolRouter } = await import("../dist/index.js");
  const router = new ToolRouter({ sources: [github.source] });
  const schema = await router.executeMetaTool("get_tool_schemas", {
    toolIds: ["github.get_issue"]
  });

  assert.equal(schema.isError, false);
  assert.match(schema.content[0].text, /issue_number/);
});

test("shares one initialization across concurrent first-use calls", async () => {
  let listCalls = 0;
  let releaseList;
  const listed = new Promise((resolve) => {
    releaseList = resolve;
  });

  const source = createToolSource({
    id: "github",
    name: "github",
    listTools: async () => {
      listCalls += 1;
      await listed;
      return {
        tools: [{ name: "get_issue", description: "Get GitHub issue" }]
      };
    },
    callTool: async (name, args) => ({ name, args })
  });

  const { ToolRouter } = await import("../dist/index.js");
  const router = new ToolRouter({ sources: [source] });

  const searchPromise = router.searchTools({ query: "issue" });
  const callPromise = router.callTool({ toolId: "github.get_issue", args: {} });

  releaseList();

  const [results, call] = await Promise.all([searchPromise, callPromise]);
  assert.equal(listCalls, 1);
  assert.equal(results[0].toolName, "get_issue");
  assert.deepEqual(call, { name: "get_issue", args: {} });
});

test("refresh invalidates ai-sdk adapter tool cache", async () => {
  let phase = 1;
  const client = {
    async listTools() {
      if (phase === 1) {
        return {
          tools: [{ name: "get_issue", description: "Get GitHub issue" }]
        };
      }
      return {
        tools: [{ name: "list_pull_requests", description: "List pull requests" }]
      };
    },
    async tools() {
      if (phase === 1) {
        return {
          get_issue: {
            execute: async (args) => ({ tool: "get_issue", args })
          }
        };
      }
      return {
        list_pull_requests: {
          execute: async (args) => ({ tool: "list_pull_requests", args })
        }
      };
    }
  };

  const { ToolRouter, asToolSource } = await import("../dist/index.js");
  const router = new ToolRouter({
    sources: [asToolSource("github", client)]
  });

  await router.searchTools({ query: "issue" });
  await router.callTool({ toolId: "github.get_issue", args: { issue_number: 1 } });

  phase = 2;
  await router.refresh();

  const results = await router.searchTools({ query: "pull requests" });
  const call = await router.callTool({
    toolId: "github.list_pull_requests",
    args: { state: "open" }
  });

  assert.equal(results[0].toolName, "list_pull_requests");
  assert.deepEqual(call, {
    tool: "list_pull_requests",
    args: { state: "open" }
  });
});

test("rejects duplicate meta-tool names in configuration", async () => {
  const { ToolRouter } = await import("../dist/index.js");
  assert.throws(
    () => {
      new ToolRouter({
        sources: [],
        metaToolNames: {
          searchTools: "my_tool",
          callTool: "my_tool"
        }
      });
    },
    /duplicate names detected/
  );
});

test("rejects discovered tools that collide with active meta-tool names", async () => {
  const source = fakeSource("github", [
    {
      name: "search_tools",
      description: "A tool that collides with the default meta-tool"
    }
  ]);

  const { ToolRouter } = await import("../dist/index.js");
  const router = new ToolRouter({ sources: [source.source] });

  await assert.rejects(
    router.initialize(),
    /Tool collision: Server "github" exposes a tool named "search_tools" which conflicts/
  );
});

test("allows excluding meta-tools to resolve collisions", async () => {
  const source = fakeSource("github", [
    {
      name: "search_tools",
      description: "A tool that collides with the default meta-tool, but we exclude the meta-tool"
    }
  ]);

  const { ToolRouter } = await import("../dist/index.js");
  const router = new ToolRouter({
    sources: [source.source],
    excludeMetaTools: ["search_tools"]
  });

  await router.initialize();
  const results = await router.searchTools({ query: "search_tools" });
  assert.equal(results[0].toolName, "search_tools");
});

test("pinned tools appear in getVisibleTools alongside meta-tools", async () => {
  const source = fakeSource("github", [
    { name: "help", description: "Get help" },
    { name: "status", description: "Get server status" },
    { name: "create_issue", description: "Create a GitHub issue" }
  ]);

  const router = await createToolRouter({
    sources: [source.source],
    pinnedTools: ["help", "status"]
  });

  const { pinned, metaTools } = router.getVisibleTools();
  assert.deepEqual(pinned.map((t) => t.toolName), ["help", "status"]);
  assert.equal(metaTools.length, 4);
});

test("pinned tools are excluded from search results", async () => {
  const source = fakeSource("github", [
    { name: "help", description: "Get help and documentation" },
    { name: "create_issue", description: "Create a GitHub issue" }
  ]);

  const router = await createToolRouter({
    sources: [source.source],
    pinnedTools: ["help"]
  });

  const results = await router.searchTools({ query: "help" });
  assert.equal(results.find((r) => r.toolName === "help"), undefined);
});

test("pinned tools remain callable via callTool", async () => {
  const source = fakeSource("github", [
    { name: "help", description: "Get help" }
  ]);

  const router = await createToolRouter({
    sources: [source.source],
    pinnedTools: ["help"]
  });

  const result = await router.callTool({ toolId: "github.help", args: {} });
  assert.deepEqual(result, { source: "github", name: "help", args: {} });
});

test("unknown pinned tool names are silently omitted", async () => {
  const source = fakeSource("github", [
    { name: "create_issue", description: "Create issue" }
  ]);

  const router = await createToolRouter({
    sources: [source.source],
    pinnedTools: ["nonexistent_tool"]
  });

  const { pinned } = router.getVisibleTools();
  assert.equal(pinned.length, 0);
});

test("policy-denied tools are excluded from search results", async () => {
  const source = fakeSource("github", [
    { name: "delete_repo", description: "Delete a repository" },
    { name: "get_issue", description: "Get an issue" }
  ]);

  const router = await createToolRouter({
    sources: [source.source],
    policy: { denyTools: ["github.delete_repo"] }
  });

  const results = await router.searchTools({ query: "issue" });
  assert.equal(results.find((r) => r.toolName === "delete_repo"), undefined);
  assert.equal(results.find((r) => r.toolName === "get_issue")?.toolName, "get_issue");
});

test("policy-denied pinned tools are excluded from visible tools", async () => {
  const source = fakeSource("github", [
    { name: "delete_repo", description: "Delete a repository" },
    { name: "get_issue", description: "Get an issue" }
  ]);

  const router = await createToolRouter({
    sources: [source.source],
    pinnedTools: ["delete_repo", "get_issue"],
    policy: { denyTools: ["github.delete_repo"] }
  });

  const { pinned } = router.getVisibleTools();
  assert.deepEqual(pinned.map((tool) => tool.toolName), ["get_issue"]);
});

test("listServers uses normalized server ids without duplicates", async () => {
  const source = fakeSource("GitHub Server", [
    { name: "get_issue", description: "Get issue" }
  ]);

  const router = await createToolRouter({ sources: [source.source] });
  assert.deepEqual(router.listServers(), [
    {
      serverId: "github_server",
      serverName: "GitHub Server",
      toolCount: 1
    }
  ]);
});

test("pinned ai-sdk tools preserve annotations", async () => {
  const source = fakeSource("github", [
    {
      name: "delete_repo",
      description: "Delete a repository",
      annotations: { destructiveHint: true, title: "Delete Repository" }
    }
  ]);

  const { createAISDKTools } = await import("../dist/index.js");
  const router = await createToolRouter({
    sources: [source.source],
    pinnedTools: ["delete_repo"]
  });

  const tools = await createAISDKTools(router);
  assert.deepEqual(tools.delete_repo.annotations, {
    destructiveHint: true,
    title: "Delete Repository"
  });
});

test("search meta tool does not expose annotations", async () => {
  const source = fakeSource("github", [
    {
      name: "delete_repo",
      description: "Delete a repository",
      annotations: { destructiveHint: true, title: "Delete Repository" }
    }
  ]);

  const router = await createToolRouter({ sources: [source.source] });
  const search = await router.executeMetaTool("search_tools", { query: "delete" });

  assert.equal(search.isError, false);
  assert.doesNotMatch(search.content[0].text, /destructiveHint|Delete Repository/);
  assert.equal(search.structuredContent, undefined);
});

test("schema meta tool does not expose annotations", async () => {
  const source = fakeSource("github", [
    {
      name: "delete_repo",
      description: "Delete a repository",
      annotations: { destructiveHint: true, title: "Delete Repository" },
      inputSchema: { type: "object", properties: { repo: { type: "string" } } }
    }
  ]);

  const router = await createToolRouter({ sources: [source.source] });
  const schema = await router.executeMetaTool("get_tool_schemas", {
    toolIds: ["github.delete_repo"]
  });

  assert.equal(schema.isError, false);
  assert.match(schema.content[0].text, /Parameters/);
  assert.doesNotMatch(schema.content[0].text, /destructiveHint|Delete Repository/);
  assert.equal(schema.structuredContent, undefined);
});

test("search results expose canonical tool ids", async () => {
  const source = fakeSource("github", [
    { name: "get_issue", description: "Get an issue" }
  ]);

  const router = await createToolRouter({ sources: [source.source] });
  const [result] = await router.searchTools({ query: "issue" });

  assert.equal(result.toolId, "github.get_issue");
});

test("getToolSchemas supports batch tool ids", async () => {
  const source = fakeSource("github", [
    { name: "get_issue", description: "Get issue", inputSchema: { type: "object" } },
    { name: "list_pull_requests", description: "List pull requests", inputSchema: { type: "object" } }
  ]);

  const router = await createToolRouter({ sources: [source.source] });
  const schemas = router.getToolSchemas({
    toolIds: ["github.get_issue", "github.list_pull_requests"]
  });

  assert.deepEqual(schemas.map((schema) => schema.toolId), [
    "github.get_issue",
    "github.list_pull_requests"
  ]);
});

