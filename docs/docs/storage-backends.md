---
sidebar_position: 3
---

import { DocIcon } from '@site/src/components/DocIcons';

# Storage Backends

The library supports multiple storage backends for session persistence, allowing you to choose the best option for your deployment environment.

## <DocIcon type="backends" size={28} /> Available Backends

### <DocIcon type="redis" size={24} /> Redis (Production)

**Recommended for production and serverless deployments.**

Redis provides distributed, persistent storage with automatic TTL (Time To Live) management. Perfect for:
- Production environments
- Serverless deployments (Vercel, AWS Lambda)
- Multi-instance applications
- High-availability setups

**Installation:**

```bash
npm install @mcp-ts/sdk ioredis
```

**Configuration:**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=redis

# Redis connection URL (required)
REDIS_URL=redis://localhost:6379

# Or for cloud Redis with TLS
REDIS_URL=rediss://default:password@host.upstash.io:6379
```

**Features:**
- <DocIcon type="success" size={16} /> Automatic session expiration (12 hours TTL)
- <DocIcon type="success" size={16} /> Atomic operations for data consistency
- <DocIcon type="success" size={16} /> Distributed storage across instances
- <DocIcon type="success" size={16} /> Production-ready scalability

**Usage:**

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage automatically uses Redis when REDIS_URL is set
const sessionId = storage.generateSessionId();

await storage.createSession({
  sessionId,
  identity: 'user-123',
  serverUrl: 'https://mcp.example.com',
  callbackUrl: 'https://app.com/callback',
  transportType: 'sse',
  active: true,
  createdAt: Date.now(),
});
```

---

### <DocIcon type="filesystem" size={24} /> File System (Development)

**Perfect for local development with persistent sessions across restarts.**

File storage persists sessions to a JSON file on disk. Ideal for:
- Local development
- Single-instance deployments
- Testing with persistent state
- Environments without Redis

**Configuration:**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=file

# File path for session storage (required)
MCP_TS_STORAGE_FILE=./sessions.json
```

**Features:**
- <DocIcon type="success" size={16} /> Persistent across application restarts
- <DocIcon type="success" size={16} /> No external dependencies
- <DocIcon type="success" size={16} /> Human-readable JSON format
- <DocIcon type="success" size={16} /> Automatic directory creation

**Usage:**

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage automatically uses File when MCP_TS_STORAGE_FILE is set
const sessions = await storage.getIdentitySessionsData('user-123');
console.log('Stored sessions:', sessions);
```

**File Format:**

```json
[
  {
    "sessionId": "abc123",
    "identity": "user-123",
    "serverId": "server-1",
    "serverName": "My MCP Server",
    "serverUrl": "https://mcp.example.com",
    "callbackUrl": "https://app.com/callback",
    "transportType": "sse",
    "active": true,
    "createdAt": 1706234567890
  }
]
```

---

### <DocIcon type="memory" size={24} /> In-Memory (Testing)

**Fast ephemeral storage, ideal for testing. Sessions are lost on restart.**

In-memory storage keeps sessions in RAM. Best for:
- Unit testing
- Integration testing
- Quick prototyping
- Temporary sessions

**Configuration:**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=memory

# No additional configuration needed
```

---

### <DocIcon type="sqlite" size={24} /> SQLite (Persistent & Fast)

**Zero-configuration persistent storage, faster than file based.**

SQLite provides a single-file relational database that is robust and requires no external server process.

**Installation:**

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

**Configuration:**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=sqlite

# SQLite DB Path (optional, defaults to ./sessions.db)
MCP_TS_STORAGE_SQLITE_PATH=./data/mcp.db
```

**Features:**
- <DocIcon type="success" size={16} /> Persistent single-file database
- <DocIcon type="bolt" size={16} /> Much faster than JSON file storage
- <DocIcon type="success" size={16} /> ACID compliant transactions
- <DocIcon type="success" size={16} /> Zero configuration (auto-creates DB)

**Features:**
- <DocIcon type="success" size={16} /> Fastest performance
- <DocIcon type="success" size={16} /> No external dependencies
- <DocIcon type="success" size={16} /> Zero configuration
- <DocIcon type="warning" size={16} /> Sessions lost on restart

**Usage:**

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

### <DocIcon type="supabase" size={24} /> Supabase (Production)

**Cloud-native PostgreSQL storage with built-in security and row-level security (RLS).**

Supabase provides a powerful, scalable backend for your MCP sessions. Ideal for:
- Production environments
- Next.js applications (built-in integration)
- Applications requiring Row Level Security (RLS)
- Managed PostgreSQL with zero maintenance

**Installation:**

```bash
npm install @mcp-ts/sdk @supabase/supabase-js
```

**Configuration:**

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=supabase

# Supabase connection details (required)
SUPABASE_URL=https://your-project.supabase.co
# Use the service_role key for server-side storage (not the anon key)
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

:::warning
**Always use `SUPABASE_SERVICE_ROLE_KEY`** for server-side storage — not `SUPABASE_ANON_KEY`. The anon key is subject to Row Level Security (RLS) policies which will block session creation. The service_role key is designed for trusted server-to-server communication and bypasses RLS. Find it in: **Supabase Dashboard → Project Settings → API → service_role**.
:::

**Database Setup:**

To use Supabase as a storage backend, you must create the `mcp_sessions` table and configure RLS policies.

#### Option A: Supabase CLI (Recommended)
You can easily "eject" the required migration SQL into your own project using the built-in CLI:

1. Run the initialization command:
   ```bash
   npx mcp-ts supabase-init
   ```
   This will copy the migration files to your local `./supabase/migrations/` folder.

2. Link your project & push:
   ```bash
   npx supabase link --project-ref <your-project-id>
   npx supabase db push
   ```

#### Option B: SQL Editor (Manual)
If you prefer manual setup, copy the SQL from the [migration file](https://github.com/zonlabs/mcp-ts/blob/main/supabase/migrations/20260330195700_install_mcp_sessions.sql) and run it in the Supabase Dashboard SQL Editor.

**Features:**
- <DocIcon type="success" size={16} /> PostgreSQL persistence with JSONB support
- <DocIcon type="lock" size={16} /> Row Level Security (RLS) for tenant isolation
- <DocIcon type="success" size={16} /> Automatic updated_at and expires_at management
- <DocIcon type="bolt" size={16} /> Cloud-native and serverless friendly
- <DocIcon type="lock" size={16} /> Application-level AES-256-GCM encryption for `tokens` and `headers`

**Usage:**

```typescript
import { createSupabaseStorageBackend } from '@mcp-ts/sdk/server';
import { createClient } from '@supabase/supabase-js';

// Always use the service_role key for server-side usage
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const storage = createSupabaseStorageBackend(supabase);

await storage.createSession({
  sessionId: 'sb-123',
  identity: 'user-789',
  serverUrl: 'https://mcp.example.com',
  callbackUrl: 'https://app.com/callback',
  transportType: 'sse',
  active: true,
  createdAt: Date.now(),
});
```

**Encryption at Rest:**

The Supabase backend automatically encrypts sensitive session fields (`tokens` and `headers`) using **AES-256-GCM** before writing to the database. All encryption/decryption happens transparently in your Node.js application — Supabase only ever sees cipher text.

To enable encryption, set the `STORAGE_ENCRYPTION_KEY` environment variable to a 32-byte hex string:

```bash
# Generate a secure key:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
STORAGE_ENCRYPTION_KEY=your-64-character-hex-string
```

Once set, encrypted data in the database will look like this:

```json
{
  "tokens": "enc:1:cd4511ef932b...:3f2a1b...:a4b5c6d7...",
  "headers": "enc:1:1234abcd...:..."
}
```

:::tip
If `STORAGE_ENCRYPTION_KEY` is **not** set, `mcp-ts` will print a single startup warning and save data without encryption — your app will not crash. This allows you to opt-in gradually or skip encryption in local dev.
:::

:::warning
Never commit `STORAGE_ENCRYPTION_KEY` to version control. Treat it the same as a database password. If it is lost, encrypted session data from the database cannot be recovered.
:::

---

### <DocIcon type="browser" size={24} /> LocalStorage (Browser)

**Client-side persistent storage for browser environments — no server required.**

LocalStorage is the ideal backend for fully client-side MCP applications (SPAs, demos, embedded browser tools) that want sessions to survive page refreshes without any backend infrastructure.

**Best for:**
- Single-page applications (React, Vue, etc.)
- Browser-embedded MCP tools and demos
- Offline-capable or zero-backend apps
- Local development without any external services

:::warning
**XSS Risk:** `localStorage` is accessible to all scripts on the same origin. Do **not** store sensitive OAuth tokens in a high-security context using this backend. Use Redis or Supabase for production server-side deployments.
:::

:::note
**Browser-only:** This backend calls `window.localStorage` and will not work in Node.js environments. When `MCP_TS_STORAGE_TYPE=localstorage` is set but `window` is undefined, it automatically falls back to in-memory storage.
:::

**Configuration:**

```bash
# Explicit selection
MCP_TS_STORAGE_TYPE=localstorage

# Optional: custom namespace prefix (default: "mcp-ts")
# Useful if multiple apps share the same origin
MCP_TS_STORAGE_LS_NAMESPACE=my-app
```

**Features:**
- <DocIcon type="success" size={16} /> Persistent across page refreshes (survives browser restart)
- <DocIcon type="success" size={16} /> Zero external dependencies
- <DocIcon type="success" size={16} /> Optional TTL with lazy expiry eviction
- <DocIcon type="success" size={16} /> Namespace prefix to avoid key collisions
- <DocIcon type="warning" size={16} /> Browser-only (not available in Node.js)
- <DocIcon type="warning" size={16} /> Same-origin only (~5–10 MB quota)
- <DocIcon type="error" size={16} /> Not suitable for multi-user or multi-instance deployments

**Manual instantiation (recommended for browser apps):**

```typescript
import { LocalStorageBackend } from '@mcp-ts/sdk/server';

// Minimal setup
const storage = new LocalStorageBackend();
await storage.init();

// With options
const storage = new LocalStorageBackend({
  namespace: 'my-app',   // key prefix (default: 'mcp-ts')
  defaultTtl: 3600,      // 1-hour sessions (default: 43200 = 12h)
                         // set to 0 for no expiry
});
await storage.init();
```

**Key storage format:**

```
localStorage["mcp-ts:session:user-123:abc456"] = JSON string (SessionData + optional _expiresAt)
localStorage["mcp-ts:idx:user-123"]            = JSON string[] (session IDs for that identity)
localStorage["mcp-ts:identities"]              = JSON string[] (all known identities)
```

---

### <DocIcon type="postgres" size={24} /> PostgreSQL

For self-hosted PostgreSQL environments.

**Features:**
- <DocIcon type="success" size={16} /> Relational data storage
- <DocIcon type="success" size={16} /> Advanced querying capabilities
- <DocIcon type="success" size={16} /> ACID compliance
- <DocIcon type="success" size={16} /> Integration with existing databases

---

## <DocIcon type="sync" size={28} /> Automatic Backend Selection

The library automatically selects the appropriate storage backend using this priority:

```mermaid
graph TD
    A[Start] --> B{MCP_TS_STORAGE_TYPE set?}
    B -->|Yes| C[Use specified backend]
    B -->|No| D{REDIS_URL present?}
    D -->|Yes| E[Use Redis]
    D -->|No| F{SUPABASE_URL present?}
    F -->|Yes| G[Use Supabase]
    F -->|No| H{MCP_TS_STORAGE_FILE present?}
    
    C --> L[Storage Ready]
    E --> L
    G --> L
    
    H -->|Yes| I[Use File System]
    H -->|No| J{MCP_TS_STORAGE_SQLITE_PATH present?}
    
    I --> L
    J -->|Yes| K[Use SQLite]
    J -->|No| M[Use In-Memory Default]
    
    K --> L
    M --> L
```

**Priority Order:**

1. **Explicit**: If `MCP_TS_STORAGE_TYPE` is set, use that backend
2. **Auto-detect Redis**: If `REDIS_URL` is present, use Redis
3. **Auto-detect Supabase**: If `SUPABASE_URL` is present, use Supabase
4. **Auto-detect File**: If `MCP_TS_STORAGE_FILE` is present, use File
5. **Auto-detect SQLite**: If `MCP_TS_STORAGE_SQLITE_PATH` is present, use SQLite
6. **Default**: Fall back to In-Memory storage

> **Note:** `LocalStorage` is **not** auto-detected. It must be explicitly set via `MCP_TS_STORAGE_TYPE=localstorage` or instantiated directly (`new LocalStorageBackend()`) in browser code.

---

## <DocIcon type="tools" size={28} /> Custom Backend Implementation

You can use specific storage backends directly:

```typescript
import { 
  RedisStorageBackend,
  MemoryStorageBackend,
  FileStorageBackend 
} from '@mcp-ts/sdk/server';
import { Redis } from 'ioredis';

// Custom Redis instance
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: 'secret',
});
const redisStorage = new RedisStorageBackend(redis);

// Custom file path
const fileStorage = new FileStorageBackend({ 
  path: '/var/data/sessions.json' 
});
await fileStorage.init();

// In-memory for testing
const memoryStorage = new MemoryStorageBackend();
```

---

## <DocIcon type="chart" size={28} /> Backend Comparison

| Feature | <DocIcon type="redis" size={20} /> Redis | <DocIcon type="supabase" size={20} /> Supabase | <DocIcon type="sqlite" size={20} /> SQLite | <DocIcon type="filesystem" size={20} /> File System | <DocIcon type="memory" size={20} /> In-Memory | <DocIcon type="browser" size={20} /> LocalStorage |
|---------|----------|----------|----------|----------------|--------------|---------------|
| **Persistence** | <DocIcon type="success" size={16} /> Yes | <DocIcon type="success" size={16} /> Yes | <DocIcon type="success" size={16} /> Yes | <DocIcon type="success" size={16} /> Yes | <DocIcon type="error" size={16} /> No | <DocIcon type="success" size={16} /> Yes (browser) |
| **Distributed** | <DocIcon type="success" size={16} /> Yes | <DocIcon type="success" size={16} /> Yes | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No |
| **Auto-Expiry** | <DocIcon type="success" size={16} /> Yes (TTL) | <DocIcon type="success" size={16} /> Yes (Manual) | <DocIcon type="success" size={16} /> Yes (Manual) | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No | <DocIcon type="success" size={16} /> Yes (Lazy TTL) |
| **Performance** | <DocIcon type="bolt" size={16} /> Fast | <DocIcon type="bolt" size={16} /> Fast | <DocIcon type="bolt" size={16} /> Very Fast | <DocIcon type="chart" size={16} /> Medium | <DocIcon type="rocket" size={16} /> Fastest | <DocIcon type="rocket" size={16} /> Fastest |
| **Setup** | <DocIcon type="tools" size={16} /> External | <DocIcon type="tools" size={16} /> Cloud | <DocIcon type="tools" size={16} /> Native | <DocIcon type="filesystem" size={16} /> Built-in | <DocIcon type="target" size={16} /> Built-in | <DocIcon type="target" size={16} /> Built-in |
| **Serverless** | <DocIcon type="success" size={16} /> Yes | <DocIcon type="success" size={16} /> Recommended | <DocIcon type="warning" size={16} /> Limited | <DocIcon type="success" size={16} /> Yes | | <DocIcon type="success" size={16} /> Yes (browser) |
| **Production** | <DocIcon type="success" size={16} /> Recommended | <DocIcon type="success" size={16} /> Recommended | <DocIcon type="warning" size={16} /> Single-instance | <DocIcon type="error" size={16} /> Not recommended | | <DocIcon type="error" size={16} /> No |
| **Development** | <DocIcon type="success" size={16} /> Good | <DocIcon type="success" size={16} /> Excellent | <DocIcon type="success" size={16} /> Excellent | <DocIcon type="success" size={16} /> Good | | <DocIcon type="success" size={16} /> Excellent |
| **Testing** | <DocIcon type="success" size={16} /> Good | <DocIcon type="success" size={16} /> Excellent | <DocIcon type="success" size={16} /> Good | <DocIcon type="success" size={16} /> Excellent | | <DocIcon type="success" size={16} /> Good |
| **Encryption** | <DocIcon type="error" size={16} /> No | <DocIcon type="lock" size={16} /> AES-256-GCM | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No | <DocIcon type="error" size={16} /> No |
| **Environment** | Server | Server | Server | Server | Server | **Browser only** |

---

## <DocIcon type="lock" size={28} /> Session Data Structure

All backends store the same session data structure:

```typescript
interface SessionData {
  sessionId: string;
  identity?: string;
  serverId?: string;
  serverName?: string;
  serverUrl: string;
  callbackUrl: string;
  transportType: 'sse' | 'streamable_http';
  active: boolean;
  createdAt: number;
  headers?: Record<string, string>;
  // OAuth data
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformation;
  codeVerifier?: string;
  clientId?: string;
}
```

---

## <DocIcon type="idea" size={28} /> Best Practices

### Production Deployments

```bash
# Use Redis for production
MCP_TS_STORAGE_TYPE=redis
REDIS_URL=rediss://user:pass@production-redis.example.com:6379
```

### Local Development

```bash
# Use File storage for development
MCP_TS_STORAGE_TYPE=file
MCP_TS_STORAGE_FILE=./dev-sessions.json
```

### Testing

```bash
# Use in-memory for tests
MCP_TS_STORAGE_TYPE=memory
```

### Serverless (Vercel, AWS Lambda)

```bash
# Use Redis with Upstash or similar
REDIS_URL=rediss://default:token@serverless-redis.upstash.io:6379
```

### Security (Supabase)

```bash
# Enable encryption for tokens and headers at rest
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
STORAGE_ENCRYPTION_KEY=your-64-character-hex-string
```

This enables transparent AES-256-GCM encryption so that even if your Supabase database is compromised, OAuth tokens and authorization headers remain unreadable.

---

## <DocIcon type="search" size={28} /> Troubleshooting

### Redis Connection Failed

```bash
# Verify Redis is running
redis-cli ping  # Should return PONG

# Check connection string
echo $REDIS_URL

# Test with redis-cli
redis-cli -u $REDIS_URL ping
```

### File Storage Not Persisting

```bash
# Check file permissions
ls -la ./sessions.json

# Verify path is writable
touch ./sessions.json

# Check environment variable
echo $MCP_TS_STORAGE_FILE
```

### Sessions Lost on Restart

If you're using in-memory storage (default), sessions will be lost on restart. Switch to Redis or File storage for persistence:

```bash
# Add to .env
MCP_TS_STORAGE_TYPE=file
MCP_TS_STORAGE_FILE=./sessions.json
```

---

## <DocIcon type="book" size={28} /> Next Steps

- [Installation Guide](./installation.md) - Setup instructions
- [API Reference](./api-reference.md) - Complete API documentation
- [Next.js Integration](./nextjs.md) - Framework-specific guides
