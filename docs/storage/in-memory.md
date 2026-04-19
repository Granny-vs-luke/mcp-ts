---
title: "In-Memory"
sidebarTitle: "In-Memory"
description: "Fast, ephemeral session storage for testing and local development."
icon: "memory"
---

## In-Memory (Testing)

**Fast ephemeral storage, ideal for testing. Sessions are lost on restart.**

In-memory storage keeps sessions in RAM. Best for:
- Unit testing
- Integration testing
- Quick prototyping
- Temporary sessions

### Configuration

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=memory

# No additional configuration needed
```

### Usage

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage uses in-memory by default if no other backend is configured
await storage.createSession({
  sessionId: 'test-123',
  identity: 'test-user',
  serverUrl: 'https://test.example.com',
  callbackUrl: 'https://test.com/callback',
  transportType: 'sse',
  active: true,
  createdAt: Date.now(),
});
```

---

## SQLite (Persistent & Fast)

**Zero-configuration persistent storage, faster than file based.**

SQLite provides a single-file relational database that is robust and requires no external server process. Ideal for:
- Single-instance production apps
- Persistent development state
- Applications requiring ACID compliance without a full DB server

### Installation

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

### Configuration

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=sqlite

# SQLite DB Path (optional, defaults to ./sessions.db)
MCP_TS_STORAGE_SQLITE_PATH=./data/mcp.db
```

### Features

- **Persistent single-file database**
- **Much faster** than JSON file storage
- **ACID compliant** transactions
- **Zero configuration** (auto-creates DB)
