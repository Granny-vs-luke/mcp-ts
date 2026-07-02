---
title: "Supabase"
sidebarTitle: "Supabase"
description: "Use Supabase Postgres as the mcp-ts session storage backend, including service_role configuration, Row Level Security setup, and the required schema migration."
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
SUPABASE_SECRET_KEY=your-secret-key
```

<Warning>
**Always use `SUPABASE_SECRET_KEY`** for server-side storage — not `SUPABASE_ANON_KEY`. The anon key is subject to Row Level Security (RLS) policies which will block session creation. The service_role key is designed for trusted server-to-server communication and bypasses RLS. Find it in: **Supabase Dashboard → Project Settings → API → service_role**.
</Warning>

## Database Setup

To use Supabase as a storage backend, you must create the `mcp_sessions` table and configure RLS policies.

### Option A: Supabase CLI (Recommended)
You can easily "eject" the required migration SQL into your own project using the built-in CLI:

1. Run the initialization command:
   ```bash
   npx mcp-ts supabase-init
   ```
   This copies the provider migrations from `migrations/supabase/` in the package to your local `./supabase/migrations/` folder.

2. Link your project & push:
   ```bash
   npx supabase link --project-ref <your-project-id>
   npx supabase db push
   ```

### Option B: SQL Editor (Manual)
If you prefer manual setup, copy the SQL from the [migration file](https://github.com/zonlabs/mcp-ts/blob/main/migrations/supabase/20260330195700_install_mcp_sessions.sql) and run it in the Supabase Dashboard SQL Editor.

### Why RLS ?

`mcp-ts` uses the `service_role` key for server-side Supabase storage, and that key bypasses RLS. Session access is still scoped by `userId` in application queries.

The migration also defines RLS policies for Supabase's authenticated client path. If the `mcp_sessions` table is queried through that path, the policies use `auth.uid()` to ensure users can only access rows where `user_id` matches their Supabase user ID.

## Schema

The canonical Supabase migration is available at `migrations/supabase/20260330195700_install_mcp_sessions.sql`.

Unlike the simpler single-table examples in some backends, the Supabase install migration separates durable connection metadata from runtime OAuth credentials:

- `public.mcp_sessions` stores connection/session metadata
- `public.mcp_credentials` stores runtime OAuth credentials and is linked by `(user_id, session_id)`

Run the migration with your trusted database role before connecting your application with `SUPABASE_SECRET_KEY`.

### `public.mcp_sessions`

```sql
CREATE TABLE IF NOT EXISTS public.mcp_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    server_id TEXT,
    server_name TEXT,
    server_url TEXT NOT NULL,
    transport_type TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active')),
    headers JSONB,
    auth_url TEXT,
    tool_policy JSONB,
    CONSTRAINT mcp_sessions_user_session_unique
        UNIQUE (user_id, session_id)
);
```

### `public.mcp_credentials`

```sql
CREATE TABLE IF NOT EXISTS public.mcp_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    client_information JSONB,
    tokens JSONB,
    code_verifier TEXT,
    client_id TEXT,
    oauth_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mcp_credentials_session_fk
        FOREIGN KEY (user_id, session_id)
        REFERENCES public.mcp_sessions(user_id, session_id)
        ON DELETE CASCADE,
    CONSTRAINT mcp_credentials_user_session_unique
        UNIQUE (user_id, session_id)
);
```

### Indexes and update triggers

```sql
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user_id ON public.mcp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires_at ON public.mcp_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_credentials_user_session
ON public.mcp_credentials(user_id, session_id);

CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_sessions_updated_at ON public.mcp_sessions;
CREATE TRIGGER trg_mcp_sessions_updated_at
BEFORE UPDATE ON public.mcp_sessions
FOR EACH ROW
EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS trg_mcp_credentials_updated_at ON public.mcp_credentials;
CREATE TRIGGER trg_mcp_credentials_updated_at
BEFORE UPDATE ON public.mcp_credentials
FOR EACH ROW
EXECUTE FUNCTION public.set_current_timestamp_updated_at();
```

### RLS policies

The install migration enables RLS on both tables and creates authenticated-user policies for `SELECT`, `INSERT`, `UPDATE`, and `DELETE`, each scoped to:

```sql
auth.uid()::text = user_id
```

That means:

- authenticated users can only access rows tied to their own Supabase user ID
- server-side code using `SUPABASE_SECRET_KEY` bypasses those policies, which is why `mcp-ts` recommends that key for backend storage operations

## Features

- **PostgreSQL persistence** with JSONB support
- **Row Level Security (RLS)** for tenant isolation
- **Automatic management** of `updated_at` and `expires_at`
- **Automatic session cleanup** via `pg_cron` — expired pending sessions are swept every 5 minutes
- **Cloud-native** and serverless friendly
- **Application-level AES-256-GCM encryption** for `tokens` and `headers`

## Session Cleanup

When a client disconnects unexpectedly or a connection error occurs during setup, session data can become stale in the database. To prevent leftover data from accumulating, `mcp-ts` includes a migration that sets up automatic cleanup jobs using PostgreSQL's [`pg_cron`](https://supabase.com/docs/guides/database/extensions/pg_cron) extension.

<Info>
The `pg_cron` extension is available on all Supabase plans (including Free). The cleanup migrations are included automatically when you run `npx mcp-ts supabase-init`.
</Info>

### Session Lifecycle Management

`mcp-ts` implements a multi-stage automated cleanup strategy to keep your database lean while preserving long-lived automation credentials:

**Stage 1: Short-term Transient Purge** (Every 5 minutes)

Cleans up abandoned setup/auth records. These are sessions where `status <> 'active'` and the short 10-minute pending expiration has passed.

```sql
DELETE FROM mcp_sessions
WHERE expires_at IS NOT NULL
  AND expires_at < now()
  AND status <> 'active';
```

**Stage 2: Long-term Dormancy Eviction** (Daily at midnight UTC)

A safety net for successfully established sessions (`status = 'active'`) that have been completely untouched for 30+ days. This ensures that even active sessions don't persist forever if they are genuinely abandoned.

```sql
DELETE FROM mcp_sessions WHERE status = 'active' AND updated_at < now() - interval '30 days';
```

### How It Works

1. **Transient State**: Pending sessions use `status: 'pending'` and a restricted 10-minute pending expiration.
2. **Promotion**: Upon successful handshake or OAuth completion, the session is promoted to `status: 'active'` and `expires_at` is cleared.
3. **Persistence**: Active sessions are **explicitly excluded** from the high-frequency 5-minute sweep. This makes them safe for persistent automation and scheduled workflows.
4. **Eviction**: If an active session is not used or refreshed for 30 consecutive days, it is considered dormant and is evicted by the daily sweep.

### Customizing the Lifecycle

You can modify the cron schedules directly in your Supabase SQL editor:

```sql
-- Adjust the Stage 1 frequency (e.g., to 15 minutes)
SELECT cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname = 'cleanup-transient-sessions'),
    schedule := '*/15 * * * *'
);

-- Adjust the Stage 2 dormancy threshold (e.g., to 90 days)
SELECT cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname = 'cleanup-dormant-sessions'),
    schedule := '0 0 * * *',
    command := $$DELETE FROM public.mcp_sessions WHERE status = 'active' AND updated_at < now() - interval '90 days';$$
);
```

### Disabling Management

To disable the automated lifecycle management entirely:

```sql
SELECT cron.unschedule('cleanup-transient-sessions');
SELECT cron.unschedule('cleanup-dormant-sessions');
```

## Usage

### Option 1: Automatic Detection (Recommended)

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are present in your environment, the global `sessions` proxy automatically uses the Supabase backend.

```typescript
import { sessions } from '@mcp-ts/sdk/server';

// This will use Supabase automatically if env vars are set
await sessions.create({
  sessionId: 'sb-123',
  userId: 'user-789',
  serverUrl: 'https://mcp.example.com',
  callbackUrl: 'https://app.com/callback',
  transportType: 'streamable-http',
  status: 'active',
  createdAt: Date.now(),
});
```

### Option 2: Manual Instantiation

If you want to manage the Supabase client yourself or use multiple storage backends:

```typescript
import { createSupabaseStorageBackend } from '@mcp-ts/sdk/server';
import { createClient } from '@supabase/supabase-js';

// Always use the service_role key for server-side usage
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

const supabaseBackend = createSupabaseStorageBackend(supabase);
await supabaseBackend.init(); // Optional but recommended to verify connection

await supabaseBackend.create({
  sessionId: 'sb-123',
  userId: 'user-789',
  serverUrl: 'https://mcp.example.com',
  callbackUrl: 'https://app.com/callback',
  transportType: 'streamable-http',
  status: 'active',
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
