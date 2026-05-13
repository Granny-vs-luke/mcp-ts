---
title: "Neon"
sidebarTitle: "Neon"
description: "Serverless Postgres session storage powered by Neon."
---

**Serverless Postgres storage for production deployments.**

Neon support uses the optional `@neondatabase/serverless` peer dependency and the HTTP query API. It is a good fit for serverless applications that need durable MCP session storage without running Redis.

## Installation

```bash
npm install @neondatabase/serverless
```

## Configuration

```bash
MCP_TS_STORAGE_TYPE=neon
NEON_DATABASE_URL=postgresql://user:password@host.neon.tech/dbname?sslmode=verify-full&channel_binding=require
```

`DATABASE_URL` is also supported when `MCP_TS_STORAGE_TYPE=neon` is set. Auto-detection only uses `NEON_DATABASE_URL` so a generic `DATABASE_URL` does not unexpectedly change the selected storage backend.

Use a pooled Neon connection string for serverless deployments when your app may create many concurrent function instances. Neon integrations commonly expose pooled URLs through `DATABASE_URL`; direct/unpooled URLs are better reserved for migrations and long-running administrative work.

## Security

Create a dedicated application role instead of using the Neon owner/admin role in production. The role only needs to connect to the database and read/write the `mcp_sessions` table.

```sql
CREATE ROLE mcp_ts_app LOGIN PASSWORD 'replace-with-a-strong-password';

GRANT CONNECT ON DATABASE neondb TO mcp_ts_app;
GRANT USAGE ON SCHEMA public TO mcp_ts_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_sessions TO mcp_ts_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO mcp_ts_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_ts_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE ON SEQUENCES TO mcp_ts_app;
```

For strongest transport security, prefer `sslmode=verify-full`. Add `channel_binding=require` when supported by your runtime and connection path. Do not log or commit Neon connection strings; store them in your deployment environment variables.

## Schema

Create the `mcp_sessions` table in your Neon database:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
    expires_at TIMESTAMPTZ NOT NULL,
    active BOOLEAN DEFAULT false,
    identity TEXT NOT NULL,
    headers JSONB,
    client_information JSONB,
    tokens JSONB,
    code_verifier TEXT,
    client_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_identity ON public.mcp_sessions(identity);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user_id ON public.mcp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires_at ON public.mcp_sessions(expires_at);

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
```

## Usage

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage automatically uses Neon when configured with:
// MCP_TS_STORAGE_TYPE=neon
const sessions = await storage.getIdentitySessionsData('user-123');
```

You can also create the backend directly:

```typescript
import { neon } from '@neondatabase/serverless';
import { createNeonStorageBackend } from '@mcp-ts/sdk/server';

const sql = neon(process.env.NEON_DATABASE_URL!);
const storage = createNeonStorageBackend(sql);
await storage.init();
```

## Cleanup

Expired sessions are removed when `storage.cleanupExpiredSessions()` runs. Schedule that call from your application or platform cron if you want automatic cleanup.
