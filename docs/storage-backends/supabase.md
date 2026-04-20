---
title: "Supabase"
sidebarTitle: "Supabase"
description: "Scalable session storage using Supabase/PostgreSQL."
---

**Cloud-native PostgreSQL storage with built-in security and row-level security (RLS).**

Supabase provides a powerful, scalable backend for your MCP sessions. Ideal for:
- Production environments
- Next.js applications (built-in integration)
- Applications requiring Row Level Security (RLS)
- Managed PostgreSQL with zero maintenance

## Installation

```bash
npm install @mcp-ts/sdk @supabase/supabase-js
```

## Configuration

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=supabase

# Supabase connection details (required)
SUPABASE_URL=https://your-project.supabase.co
# Use the service_role key for server-side storage (not the anon key)
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

<Warning>
**Always use `SUPABASE_SERVICE_ROLE_KEY`** for server-side storage — not `SUPABASE_ANON_KEY`. The anon key is subject to Row Level Security (RLS) policies which will block session creation. The service_role key is designed for trusted server-to-server communication and bypasses RLS. Find it in: **Supabase Dashboard → Project Settings → API → service_role**.
</Warning>

## Database Setup

To use Supabase as a storage backend, you must create the `mcp_sessions` table and configure RLS policies.

### Option A: Supabase CLI (Recommended)
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

### Option B: SQL Editor (Manual)
If you prefer manual setup, copy the SQL from the [migration file](https://github.com/zonlabs/mcp-ts/blob/main/supabase/migrations/20260330195700_install_mcp_sessions.sql) and run it in the Supabase Dashboard SQL Editor.

## Features

- **PostgreSQL persistence** with JSONB support
- **Row Level Security (RLS)** for tenant isolation
- **Automatic management** of `updated_at` and `expires_at`
- **Cloud-native** and serverless friendly
- **Application-level AES-256-GCM encryption** for `tokens` and `headers`

## Usage

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

## Encryption at Rest

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

<Tip>
If `STORAGE_ENCRYPTION_KEY` is **not** set, `mcp-ts` will print a single startup warning and save data without encryption. This allows you to opt-in gradually or skip encryption in local dev.
</Tip>

<Warning>
Never commit `STORAGE_ENCRYPTION_KEY` to version control. Treat it the same as a database password. If it is lost, encrypted session data from the database cannot be recovered.
</Warning>
