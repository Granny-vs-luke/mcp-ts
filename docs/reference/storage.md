---
title: "Storage API"
sidebarTitle: "Storage"
description: "Global storage API methods and custom backend integration."
icon: "database"
---

### `storage`

Global storage instance that automatically selects the appropriate backend based on environment configuration.

```typescript
import { storage } from '@mcp-ts/sdk/server';
```

#### Configuration

The storage backend is selected automatically:

```bash
# Redis (Production)
MCP_TS_STORAGE_TYPE=redis
REDIS_URL=redis://localhost:6379

# File System (Development)
MCP_TS_STORAGE_TYPE=file
MCP_TS_STORAGE_FILE=./sessions.json

# In-Memory (Testing - Default)
MCP_TS_STORAGE_TYPE=memory
```

---

### Storage Methods

**`generateSessionId(): string`**

Generate a unique session ID.

```typescript
const sessionId = storage.generateSessionId();
```

---

**`createSession(session: SessionData): Promise<void>`**

Create a new session. Throws if session already exists.

```typescript
await storage.createSession({
  sessionId: 'abc123',
  identity: 'user-123',
  serverId: 'server-id',
  serverName: 'My Server',
  serverUrl: 'https://mcp.example.com',
  callbackUrl: 'https://myapp.com/callback',
  transportType: 'sse',
  active: true,
  createdAt: Date.now(),
});
```

---

**`updateSession(identity: string, sessionId: string, data: Partial<SessionData>): Promise<void>`**

Update an existing session with partial data. Throws if session doesn't exist.

```typescript
await storage.updateSession('user-123', 'abc123', {
  active: false,
  tokens: {
    access_token: 'new-token',
    token_type: 'Bearer',
  },
});
```

---

**`getSession(identity: string, sessionId: string): Promise<SessionData | null>`**

Retrieve session data.

```typescript
const session = await storage.getSession('user-123', 'abc123');
```

---

**`getUserSession(identity: string): Promise<SessionData[]>`**

Get all session data for an identity.

```typescript
const sessions = await storage.getUserSession('user-123');
```

---

**`getUserSessionIds(identity: string): Promise<string[]>`**

Get all session IDs for an identity.

```typescript
const sessionIds = await storage.getUserSessionIds('user-123');
```

---

**`removeSession(identity: string, sessionId: string): Promise<void>`**

Delete a session.

```typescript
await storage.removeSession('user-123', 'abc123');
```

---

**`getAllSessionIds(): Promise<string[]>`**

Get all session IDs across all users (admin operation).

```typescript
const allSessions = await storage.getAllSessionIds();
```

---

**`clearAll(): Promise<void>`**

Clear all sessions (admin operation).

```typescript
await storage.clearAll();
```

---

**`cleanupExpiredSessions(): Promise<void>`**

Clean up expired sessions (Redis only, no-op for others).

```typescript
await storage.cleanupExpiredSessions();
```

---

**`disconnect(): Promise<void>`**

Disconnect from storage backend.

```typescript
await storage.disconnect();
```

---

### Custom Storage Backends

You can also use specific storage backends directly:

```typescript
import { 
  RedisStorageBackend,
  MemoryStorageBackend,
  FileStorageBackend 
} from '@mcp-ts/sdk/server';
import { Redis } from 'ioredis';

// Redis
const redis = new Redis(process.env.REDIS_URL);
const redisStorage = new RedisStorageBackend(redis);

// File System
const fileStorage = new FileStorageBackend({ path: './sessions.json' });
await fileStorage.init();

// In-Memory
const memoryStorage = new MemoryStorageBackend();
```
