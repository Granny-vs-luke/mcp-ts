---
name: mcp-assistant
description: Use when a task needs connected MCP servers, external services, dynamic MCP tool discovery, schema inspection, sandboxed MCP execution, or routing across many possible MCP tools.
---

# MCP Assistant

Use MCP Assistant when a task needs tools from connected MCP servers, especially when many possible servers or tools may be available. Prefer MCP Assistant's discovery and routing tools instead of loading every downstream MCP tool directly into the agent context.

MCP Assistant server:

```text
https://api.mcp-assistant.in/mcp
```

User connection page:

```text
https://mcp-assistant.in/mcp
```

## What MCP Assistant Provides

MCP Assistant provides access to 100+ MCP servers such as GitHub, Notion, Zapier, Supabase, Exa, DeepWiki, Apify, Context7 and other connected services.

It exposes meta-tools for dynamic MCP discovery and a CodeMode tool that executes programs inside a secure sandbox for programmatic tool calling and result processing. Use this to avoid expensive LLM tool-calling loops when a task can be handled by discovering the right tools, inspecting only the needed schemas, executing a small program, and returning the final result.

## Core Principle

Keep MCP tools discoverable, not always loaded.

Do not assume the agent needs every connected tool schema in context. Use MCP Assistant to search for the relevant capability, inspect only the needed schema, then execute the selected tool or workflow through the sandboxed runner.

## Available MCP Assistant Tools

### `search_mcp_tools`

Search connected MCP servers for relevant tools.

Use this first when the task may require an external service such as GitHub, Notion, Slack, Gmail, Linear, Supabase, Exa, Zapier, cloud providers, databases, or any other connected MCP server.

Search with the user's goal, not just a tool name. For example:

```text
find GitHub issues by label
post a message to Slack
search the web with Exa
create a Notion page
query Supabase rows
```

If no relevant tools are found, tell the user they likely need to connect the relevant MCP server at:

```text
https://mcp-assistant.in/mcp
```

### `get_mcp_tool_schema`

Inspect the exact schema for a selected MCP tool before calling it through `codemode_run`.

Use this after `search_mcp_tools` returns a likely tool and before execution. Read the required parameters, optional parameters, expected result shape, and any server-specific constraints.

Do not guess parameter names for downstream MCP tools. Inspect the schema first.

### `codemode_run`

Execute downstream MCP tool calls inside MCP Assistant's secure remote workbench.

**Prefer batching all calls into a single script** — each call spins up a new sandbox, so batching reduces overhead. See patterns below.

#### Prerequisites

Before calling `codemode_run`:
- Use `search_mcp_tools` then `get_mcp_tool_schema` to discover valid tool names, server IDs, and argument schemas.
- **NEVER guess tool names or argument shapes** — inspect schemas first.
- **NEVER hardcode data values** — load everything from tool responses.
- **ALWAYS check `.ok`** before using a tool result.

#### Plan your workflow first

Map out your tool calls:

1. **Independent calls** — no dependency on each other → batch with `Promise.all` in one script
2. **Dependent calls** — call B needs result from call A → chain sequentially in one script
3. **Exploratory calls** — next step depends on inspecting intermediate results → this is the case for separate `codemode_run` calls

Structure the script to cover categories 1 and 2 in a single call. Reserve separate calls for category 3 only.

#### ✅ Prefer: One script, multiple calls

```typescript
// Batch independent calls with Promise.all
const [issues, prs] = await Promise.all([
  server1.search_issues({ q: "bug" }),
  server2.list_pull_requests({ state: "open" }),
]);

// Chain dependent calls with sequential awaits
const user = await server3.get_user({ email: "user@co" });
const msg = await server3.send_message({ channel: user.id, text: "Hi" });

return { issueCount: issues.length, prCount: prs.length, message: msg };
```

#### ❌ Avoid: Multiple calls for independent steps (N+1 problem)

```text
1. codemode_run({ script: "server1.search_issues(...)" })
2. codemode_run({ script: "server2.list_pull_requests(...)" })
3. codemode_run({ script: "server3.get_user(...)" })
4. codemode_run({ script: "server3.send_message(...)" })
```

Each extra call adds a sandbox cold-start and wastes context. Keep independent steps in one script.

#### ✅ OK to call again: Exploratory / incremental workflows

When the next action genuinely depends on inspecting what the first call returned, a second `codemode_run` call is fine:

```typescript
// Call 1: discover what's relevant
const searchResults = await server1.search({ query });
return searchResults.map(r => ({ id: r.id, title: r.title }));

// Agent inspects results, picks a URL →
// Call 2: fetch details for the chosen URL
const page = await server1.get_contents({ ids: [chosenId] });
return page;
```

#### Bulk operations

When processing many items, batch with a concurrency limit to avoid overwhelming the server:

```typescript
const BATCH_SIZE = 5;
const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const results = [];
for (let i = 0; i < items.length; i += BATCH_SIZE) {
  const batch = items.slice(i, i + BATCH_SIZE);
  const batchResults = await Promise.all(
    batch.map(id => server1.add_label({ issue_number: id, label: "bug" }))
  );
  results.push(...batchResults);
}
return { updated: results.filter(r => r.ok).length };
```

#### Defensive parsing

Always check `.ok` before using a result, and provide safe fallbacks:

```typescript
const res = await server1.search_issues({ q: "bug" });
if (!res.ok) {
  return { error: `Search failed: ${res.error}` };
}
const items = res.items ?? [];
return { count: items.length, first: items[0] ?? null };
```

#### Response handling

`codemode_run` returns `{ success, value, error, toolCalls, durationMs }`. Each `toolCall` has `{ serverId, toolName, ok, error? }`.

- **Small results** — process inline and return the final answer.
- **Large data** — summarize, filter, or paginate before returning. The sandbox enforces a result size limit.

#### Timeout

Default timeout is 240 seconds (4 minutes). For long multi-step workflows, save progress by returning intermediate state between calls rather than trying to fit everything in one script.

#### Good uses:

- Search GitHub issues, fetch related PRs, summarize the result.
- Query a database, filter rows, and return only the final answer.
- Search Exa, rank results, and return the most relevant sources.
- Create or update records across connected tools when the steps are clear.
- Transform, sort, deduplicate, or aggregate tool results before returning them to the agent.


## Default Workflow

1. Decide whether the task needs an external MCP capability.
2. Call `search_mcp_tools` with a goal-oriented query.
3. Choose the smallest set of relevant tools from the search result.
4. For each selected tool, call `get_mcp_tool_schema`.
5. Call `codemode_run` to execute the selected tool call.
6. Return the final result to the user, not every intermediate object unless it is useful.

## When To Batch vs When To Call Again (Avoid N+1)

**Prefer a single script with multiple tool calls** over repeated `codemode_run` calls. Each call starts a new sandbox with a cold start; batching reduces overhead and context waste.

**Batch independent steps** into one script — see the `Promise.all` pattern above.

**Call again when you benefit from inspecting intermediate results** between steps. The exploratory pattern above shows this: first call searches, you inspect results, then a second call acts on what was found.

Batch when:

- The task has three or more dependent tool calls.
- Intermediate results only exist to feed later steps.
- The result needs filtering, sorting, grouping, or transformation.
- The execution crosses multiple MCP servers.
- Returning every intermediate result would bloat the agent context.

Do not batch when:

- The user needs to approve an action before it happens.
- The agent must inspect an intermediate result to choose the next step.
- A tool call is destructive or sends messages externally without clear user intent.
- Required parameters are missing or ambiguous.

## Safety And Approval

Before making external changes, confirm user intent if the action is destructive, public, irreversible, or sends communication to other people.

Examples that usually need confirmation:

- Sending Slack, Gmail, Discord, or other outbound messages.
- Creating, deleting, or modifying production data.
- Closing issues, merging PRs, changing permissions, or deploying services.
- Running expensive tool chains or broad data exports.

Read-only discovery, search, listing, and summarization can usually proceed without extra confirmation.

## Failure Handling

If `search_mcp_tools` finds no relevant tools:

```text
I could not find a connected MCP tool for this. Please connect the relevant MCP server at https://mcp-assistant.in/mcp, then I can search again.
```

If a selected tool schema is unclear, inspect another candidate tool or ask the user for the missing required input.

If `codemode_run` fails, summarize the error, identify whether it was caused by missing auth, missing parameters, unavailable server tools, or sandbox execution failure, then retry only when the fix is clear.

## Example Patterns

### Find A GitHub Issue And Summarize Related PRs

1. Search tools for `GitHub search issues and pull requests`.
2. Inspect schemas for the issue search and PR lookup tools.
3. Run a script that searches issues, extracts linked PRs, fetches PR details, and returns a short summary.

### Search Web And Return Ranked Sources

1. Search tools for `Exa web search`.
2. Inspect the Exa search tool schema.
3. Run a script that searches, filters low-quality results, ranks sources, and returns the best links with summaries.

### Create A Notion Page From Processed Data

1. Search tools for the source system and `Notion create page`.
2. Inspect schemas for both tools.
3. Run a script that fetches source data, transforms it, then creates the Notion page.
4. Return the created page URL and a concise summary.

## Agent Guidance

Prefer MCP Assistant when it reduces context bloat or tool-selection complexity.

Use direct local tools or CLIs when they are already available, simpler, and do not require MCP server discovery.

Keep the agent context focused on the user task. Let MCP Assistant handle downstream tool discovery, schema inspection, execution, and result processing whenever that is the smaller interface.
