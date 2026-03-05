# mcp-remote-server

FastAPI service that keeps persistent outbound WebSocket connections from local agents and exposes an HTTP invoke API.

## Run

```bash
uv sync
set JWT_SECRET=change_me
set JWT_ALGORITHM=HS256
set REQUEST_TIMEOUT_SECONDS=20
uv run mcp-remote-server
```

The server exposes:
- `GET /healthz`
- `GET /agents`
- `GET /agents/details`
- `WS /connect`
- `POST /{agent_id}/{mcp_server}/mcp` (streamable-http style)
- `POST /{agent_id}/{mcp_server}/sse` (SSE response)

Management endpoints:
- `GET /manage/agents/details`
- `POST /manage/jwt/issue` with `{ "subject": "...", "expiry_minutes": 60, "capabilities": ["*"] }`
- `POST /manage/jwt/revoke` with `{ "token": "..." }`
- `POST /manage/{agent_id}/{mcp_server}/server-info`

For local MCP clients like VS Code, unauthenticated MCP transport can be enabled:
- `ALLOW_UNAUTH_MCP_TRANSPORT=true` (default in this setup)

## Dashboard

This package no longer ships a built-in Streamlit dashboard.

Use the Next.js dashboard in your `mcp-client` app to manage:
- connected agents (`GET /agents/details`)
- invoke URL generation
- MCP server inspection (`initialize` + `tools/list`)

## One-Command Deploy

Run from `packages/mcp-remote-server`:

```bash
uv run mcp-remote-deploy
```

Optional flags:
- `--host nexus`
- `--remote-dir /home/ubuntu/mcp-remote-server`
- `--service mcp-remote-server`
- `--skip-verify`

This command packages local code (excluding `.venv` and `.env*`), uploads to your server, runs `uv sync`, restarts the systemd service, and checks health.
