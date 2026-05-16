import assert from "node:assert/strict";
import test from "node:test";
import { createToolRouter, createToolSource } from "../../toolrouter/dist/index.js";

const hasIsolatedVm = await import("isolated-vm").then(
  () => true,
  () => false
);

function fakeSource() {
  const calls = [];
  return {
    calls,
    source: createToolSource({
      id: "github",
      name: "github",
      listTools: async () => ({
        tools: [
          {
            name: "get_issue",
            description: "Get GitHub issue",
            inputSchema: { type: "object" }
          },
          {
            name: "delete_issue",
            description: "Delete GitHub issue",
            annotations: { destructiveHint: true },
            inputSchema: { type: "object" }
          }
        ]
      }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { name, args };
      }
    })
  };
}

test("runs async sandbox code with input and console capture", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const source = fakeSource();
  const router = await createToolRouter({ sources: [source.source] });
  const runtime = createCodeModeRuntime({ router });

  const result = await runtime.run(`
    console.log("loading", input.issueNumber);
    const issue = await callTool("github", "get_issue", {
      issue_number: input.issueNumber
    });
    return { issue, doubled: input.issueNumber * 2 };
  `, { issueNumber: 21 });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, {
    issue: { name: "get_issue", args: { issue_number: 21 } },
    doubled: 42
  });
  assert.equal(result.logs[0].level, "log");
  assert.deepEqual(result.toolCalls.map((call) => call.toolName), ["get_issue"]);
});

test("lets sandbox code search tools without full schemas", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const source = fakeSource();
  const router = await createToolRouter({ sources: [source.source] });
  const runtime = createCodeModeRuntime({ router });

  const result = await runtime.run(`
    const tools = await searchTools("github issue");
    return tools.map((tool) => ({
      sourceId: tool.sourceId,
      toolName: tool.toolName,
      inputSchema: tool.inputSchema
    }));
  `);

  assert.equal(result.error, undefined);
  assert.equal(result.value[0].sourceId, "github");
  assert.equal(result.value[0].inputSchema, undefined);
});

test("returns explicit policy errors and does not execute denied tools", { skip: !hasIsolatedVm }, async () => {
  const { createCodeModeRuntime } = await import("../dist/index.js");
  const source = fakeSource();
  const router = await createToolRouter({
    sources: [source.source],
    policy: { denyDestructiveTools: true }
  });
  const runtime = createCodeModeRuntime({ router });

  const result = await runtime.run(`
    return await callTool("github", "delete_issue", {});
  `);

  assert.equal(result.error.code, "POLICY_DENIED");
  assert.match(result.error.message, /Policy denied/);
  assert.equal(source.calls.length, 0);
});
