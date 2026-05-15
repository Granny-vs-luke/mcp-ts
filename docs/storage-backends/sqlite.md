---
title: "SQLite"
sidebarTitle: "SQLite"
description: "Single-file persistent session storage powered by SQLite."
---

**Zero-configuration persistent storage, faster than file-based JSON storage.**

SQLite provides a single-file relational database that is robust and requires no external server process. It is ideal for:

- Single-instance production apps
- Persistent development state
- Applications that need ACID transactions without a full database server
- Local deployments where Redis or Supabase would be unnecessary

## Installation

SQLite support uses the optional `better-sqlite3` peer dependency:

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

## Configuration

```bash
# Explicit selection
MCP_TS_STORAGE_TYPE=sqlite

# SQLite DB path (optional, defaults to ./sessions.db)
MCP_TS_STORAGE_SQLITE_PATH=./data/mcp.db
```

If `MCP_TS_STORAGE_TYPE` is not set, the storage layer also auto-detects SQLite when `MCP_TS_STORAGE_SQLITE_PATH` is present.

## Features

- **Persistent** single-file database
- **Fast** local reads and writes
- **ACID compliant** transactions
- **No external service** required
- **Automatic** database and table setup

## Usage

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage automatically uses SQLite when configured with
// MCP_TS_STORAGE_TYPE=sqlite or MCP_TS_STORAGE_SQLITE_PATH.
const sessions = await storage.listSessions('user-123');
console.log('Stored sessions:', sessions);
```

## Troubleshooting

### `better-sqlite3` is not installed

Install the optional dependency in the application that uses SQLite storage:

```bash
npm install better-sqlite3
```

### Database Path Is Not Writable

Make sure the parent directory exists and is writable by the process:

```bash
mkdir -p ./data
touch ./data/mcp.db
```
