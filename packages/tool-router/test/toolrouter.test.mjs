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

  assert.equal(results[0].sourceId, "github");
  assert.equal(results[0].toolName, "list_pull_requests");
  assert.equal(results[0].inputSchema, undefined);
});

test("returns schemas and proxies calls to the selected source", async () => {
  const github = fakeSource("github", [
    {
      name: "get_issue",
      description: "Get GitHub issue",
      inputSchema: { type: "object", required: ["issue_number"] }
    }
  ]);

  const router = await createToolRouter({ sources: [github.source] });
  const schema = router.getToolSchema({ sourceId: "github", toolName: "get_issue" });
  const result = await router.callTool({
    sourceId: "github",
    toolName: "get_issue",
    args: { issue_number: 7 }
  });

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
    "list_sources",
    "get_tool_schema",
    "call_tool"
  ]);

  const search = await router.executeMetaTool("search_tools", {
    query: "pull requests"
  });
  assert.equal(search.isError, false);
  assert.match(search.content[0].text, /list_pull_requests/);

  const schema = await router.executeMetaTool("get_tool_schema", {
    sourceId: "github",
    toolName: "list_pull_requests"
  });
  assert.equal(schema.isError, false);
  assert.match(schema.content[0].text, /inputSchema/);

  const call = await router.executeMetaTool("call_tool", {
    sourceId: "github",
    toolName: "list_pull_requests",
    args: { state: "open" }
  });
  assert.equal(call.isError, false);
  assert.match(call.content[0].text, /open/);
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
    router.callTool({ sourceId: "github", toolName: "delete_issue", args: {} }),
    /Policy denied/
  );
  assert.equal(github.calls.length, 0);
});
