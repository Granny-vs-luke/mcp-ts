---
title: "Installation"
sidebarTitle: "Installation"
description: "Get started with mcp-ts in your JavaScript or TypeScript project."
icon: "download"
---

## Prerequisites

Before installing, ensure you have:

- **Node.js 18+** - [Download Node.js](https://nodejs.org/)
- **Package manager** - npm, yarn, or pnpm
- **Storage Backend** (optional, defaults to in-memory):
  - **Redis** — Production distributed storage
  - **File System** — Local JSON persistence
  - **Supabase** — Cloud-native PostgreSQL
  - **SQLite** — Native persistent database

## Install the Package

Choose your preferred package manager:

```bash npm2yarn
npm install @mcp-ts/sdk
```

## Configure Storage Backend

The library automatically selects a storage backend based on your environment variables. Choose the option that best fits your needs:

### Option 1: Redis (Production)

**Recommended for production and serverless deployments.**

#### Local Redis Setup

```bash
# macOS (Homebrew)
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# Windows (WSL or Docker)
docker run -d -p 6379:6379 redis:latest
```

#### Environment Configuration

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=redis

# Redis connection URL (required)
REDIS_URL=redis://localhost:6379
```

---

### Option 2: File System (Development)

**Perfect for local development with persistent sessions across restarts.**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=file

# File path for session storage (required)
MCP_TS_STORAGE_FILE=./sessions.json
```

---

### Option 3: In-Memory (Testing)

**Fast ephemeral storage, ideal for testing. Sessions are lost on restart.**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=memory
```

This is the **default** if no storage configuration is provided.

---

## Storage Selection Logic

The library uses the following priority:

1. **Explicit**: If `MCP_TS_STORAGE_TYPE` is set, use that backend
2. **Auto-detect Redis**: If `REDIS_URL` is present, use Redis
3. **Auto-detect Supabase**: If `SUPABASE_URL` is present, use Supabase
4. **Auto-detect File**: If `MCP_TS_STORAGE_FILE` is present, use File
5. **Auto-detect SQLite**: If `MCP_TS_STORAGE_SQLITE_PATH` is present, use SQLite
6. **Default**: Fall back to In-Memory storage

See [Storage Overview](/storage/overview) for more details.

## Verify Installation

Test your setup with a simple script:

```typescript
// test-mcp.ts
import { storage } from '@mcp-ts/sdk/server';

async function test() {
  const sessionId = storage.generateSessionId();
  console.log('Generated session ID:', sessionId);

  // Test storage backend
  await storage.createSession({
    sessionId,
    identity: 'test-user',
    serverId: 'test-server',
    serverName: 'Test Server',
    serverUrl: 'https://example.com',
    callbackUrl: 'https://example.com/callback',
    transportType: 'sse',
    active: true,
    createdAt: Date.now(),
  });

  const session = await storage.getSession('test-user', sessionId);
  console.log('✓ Storage backend working!', session?.serverName);
}

test();
```

## TypeScript Configuration

If using TypeScript, ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## Next Steps

- [Storage Overvew](/storage/overview) - Detailed backend comparison
- [Next.js Integration](/nextjs) - Set up with Next.js
- [React Hook](/react) - Use the React hook
- [API Reference](/api-reference/server) - Explore the API
