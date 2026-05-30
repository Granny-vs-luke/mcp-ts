---
title: "Types & Errors"
sidebarTitle: "Types"
description: "Reference for core mcp-ts TypeScript types and error classes, including McpConnectionState, McpConnectionEvent, ToolInfo, and shared error subclasses."
icon: "code"
---

### Connection Types

```typescript
import type {
  McpConnectionState,
  McpConnectionEvent,
} from '@mcp-ts/sdk/shared';

type McpConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'DISCOVERING'
  | 'CONNECTED'
  | 'VALIDATING'
  | 'RECONNECTING'
  | 'FAILED';

type McpConnectionEvent =
  | { type: 'state_changed'; sessionId: string; state: McpConnectionState; /* ... */ }
  | { type: 'tools_discovered'; sessionId: string; tools: Tool[]; /* ... */ }
  | { type: 'auth_required'; sessionId: string; authUrl: string; /* ... */ }
  | { type: 'error'; sessionId: string; error: string; /* ... */ }
  | { type: 'disconnected'; sessionId: string; reason?: string; /* ... */ }
  | { type: 'progress'; sessionId: string; message: string; /* ... */ };
```

### Tool Types

```typescript
import type { ToolInfo } from '@mcp-ts/sdk/shared';

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
}
```

### Session Types

```typescript
interface Session {
  sessionId: string;
  userId: string;
  serverId?: string;
  serverName?: string;
  serverUrl: string;
  callbackUrl: string;
  transportType: 'sse' | 'streamable-http';
  status: 'pending' | 'active';
  createdAt: number;
  updatedAt?: number;
  expiresAt?: number | null;
  headers?: Record<string, string>;
}
```

## Error Handling

### UnauthorizedError

Thrown when OAuth authorization is required.

```typescript
import { UnauthorizedError } from '@mcp-ts/sdk/server';

try {
  await client.connect();
} catch (error) {
  if (error instanceof UnauthorizedError) {
    console.log('Redirect to:', error.authUrl);
  }
}
```
