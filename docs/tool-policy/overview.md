---
title: "Tool Policy Overview"
sidebarTitle: "Overview"
description: "Control which tools an MCP session can access using allowlist, denylist, or unrestricted modes."
---

Tool Policy lets you restrict which tools an MCP session can call. It is stored as an optional `toolPolicy` field on the `Session` object and persisted in SQL storage backends (Neon, Supabase) when provided.

## How It Works

Each session can carry a `toolPolicy` with one of three modes:

| Mode | Behavior |
|------|----------|
| `all` | All tools are allowed (default when no policy is set) |
| `allowlist` | Only the listed tool IDs are allowed |
| `denylist` | All tools are allowed **except** the listed tool IDs |

A tool ID is a composite string: `{serverId}::{toolName}` (e.g. `my-server::get_weather`).

## When to Use

- **Multi-tenant deployments** — restrict each session to a subset of tools
- **Security boundaries** — prevent a session from calling privileged tools
- **Gradual rollouts** — allowlist tools as they are vetted per session

## Session Data Structure

The `toolPolicy` field is optional on `Session`:

```typescript
interface Session {
  sessionId: string;
  userId: string;
  // ... other fields
  toolPolicy?: ToolPolicy;
}

interface ToolPolicy {
  mode: 'all' | 'allowlist' | 'denylist';
  toolIds: string[];
  updatedAt: number;
}
```

When no policy is provided (`undefined`), the SDK treats it as `all` — all tools are permitted.
