---
title: "Quickstart Guide"
sidebarTitle: "Quickstart"
description: "Get up and running with mcp-ts in 5 minutes."
icon: "rocket"
---

This guide will help you set up a basic MCP connection using `mcp-ts`.

## 1. Install

```bash
npm install @mcp-ts/sdk
```

## 2. Server-Side Setup (Next.js)

Create an API route at `app/api/mcp/route.ts` to handle MCP connections.

```typescript
import { createNextMcpHandler } from '@mcp-ts/sdk/server';

export const { GET, POST } = createNextMcpHandler({
  getIdentity: (req) => "user_123", // Replace with actual auth
});
```

## 3. Client-Side Setup

Use the `useMcp` hook in your React component to connect and call tools.

```tsx
'use client';
import { useMcp } from '@mcp-ts/sdk/client';

export function McpApp() {
  const { connections, connect, callTool, status } = useMcp({
    url: '/api/mcp',
    identity: 'user_123',
  });

  const handleConnect = () => {
    connect({
      serverId: 'everything-server',
      serverName: 'Everything Server',
      serverUrl: 'https://everything.mcp.run',
    });
  };

  return (
    <div>
      <h3>Status: {status}</h3>
      <button onClick={handleConnect}>Connect to Server</button>

      {connections.map(conn => (
        <div key={conn.sessionId}>
          <h4>{conn.serverName} ({conn.state})</h4>
          {conn.tools.map(tool => (
            <button key={tool.name} onClick={() => callTool(conn.sessionId, tool.name, {})}>
              Run {tool.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

## 4. Environment Variables

By default, `mcp-ts` uses in-memory storage. For persistence, add a backend like Redis:

```bash
REDIS_URL=redis://localhost:6379
```

## Next Steps

- Integrate with [AI SDK](/adapters/ai-sdk)
- Configure [Production Storage](/storage/redis)
- Explore the [API Reference](/api-reference/server)
