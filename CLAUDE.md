# Developer Guide (@mcp-ts/sdk)

## Overview
`@mcp-ts/sdk` is a TypeScript SDK for building Model Context Protocol (MCP) clients with support for **Server-Sent Events (SSE)**, **OAuth 2.1**, multiple storage backends, and production-ready features.

## Architecture

### 1. Server (`src/server/`)
- **`MultiSessionClient`**: Core class managing multiple MCP server connections.
- **`storage/`**: Pluggable storage backends (Redis, SQLite, File, Memory, Supabase).
- **`sse-handler.ts`**: Handles SSE streams and RPC over HTTP POST.
- **`oauth-client.ts`**: Handles OAuth 2.1 authentication flows.
- **`cli/`**: Command-line tools for initialization and setup.

### 2. Client (`src/client/`)
- **`useMcp.ts`**: React hook for connection management and UI updates.
- **`sse-client.ts`**: Browser-side client for SSE/RPC communication.
- **`vue/`**: Vue 3 composables for framework integration.

### 3. Adapters (`src/adapters/`)
Bridges for agent frameworks (optional peer dependencies):
- **`ai-adapter.ts`**: Vercel AI SDK integration.
- **`langchain-adapter.ts`**: LangChain.js integration.
- **`mastra-adapter.ts`**: Mastra framework integration.
- **`agui-adapter.ts`**: AG-UI tool adapter for converting MCP tools.
- **`agui-middleware.ts`**: AG-UI middleware for server-side MCP tool execution.

### 4. Storage Backends
Configured via `MCP_TS_STORAGE_TYPE` or auto-detected:
- **Redis**: Persistent, production-ready (`ioredis`).
- **Supabase**: PostgreSQL-backed with RLS policies and migrations (`@supabase/supabase-js`).
- **SQLite**: Local persistent, zero-config (`better-sqlite3`).
- **File**: Local JSON file (`fs`).
- **Memory**: Ephemeral testing (default).

Each backend implements health checks via `init()` method to validate connectivity at startup.

## Core Design Patterns

### Real-Time Updates (SSE)
- **Server -> Client**: Unidirectional SSE stream (tools, logs, state).
- **Client -> Server**: Standard HTTP POST for RPC calls.
- **Statelessness**: Session state reconstructed from storage; server instances are ephemeral.

### Dependency Management
- **Core**: Minimal dependencies (`nanoid`, `@modelcontextprotocol/sdk`).
- **Adapters/Storage**: **Optional Peer Dependencies** (e.g., `ai`, `langchain`, `better-sqlite3`, `@supabase/supabase-js`).
- **Dynamic Imports**: Used to load adapters/storage implementations only when requested.

### Storage Backend Initialization
- All backends implement `init()` for health checks
- Standardized logging with `[mcp-ts][Storage]` prefix and ✓ confirmations
- Auto-detection for Supabase via `SUPABASE_URL` environment variable
- Runtime validation of table/storage existence

## Development

### Commands
```bash
npm run build       # Build all entry points (tsup)
npm run type-check  # Verify types
npm run dev        # Watch mode
npm test            # Run tests
```

### Key Conventions
- **Imports**: modifying imports? Use explicit extensions `.js` for ESM compatibility.
- **Exports**: modifying exports? define exports in `package.json` and `tsup.config.ts`.
- **Testing**: Use `playwright` for e2e/integration tests in `tests/`.

## Common Tasks

### Adding a Storage Backend
1. Implement `StorageBackend` interface in `src/server/storage/`.
2. Add `init()` method for health checks.
3. Add dynamic import logic in `src/server/storage/index.ts`.
4. Add peer dependency to `package.json`.
5. Add tests in `tests/`.

### Setting Up Supabase Storage
1. Run `npx mcp-ts supabase-init` to eject migrations.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables.
3. Storage backend is auto-detected and initialized on startup.

### Adding an Adapter
1. Create `src/adapters/<name>-adapter.ts`.
2. Implement conversion from `MultiSessionClient` tools to target framework format.
3. Add peer dependency meta in `package.json`.
4. Add tests in `tests/`.
