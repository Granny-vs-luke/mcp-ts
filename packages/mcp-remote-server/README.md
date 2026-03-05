# remote-proxy

FastAPI service that keeps persistent outbound WebSocket connections from local agents and exposes an HTTP invoke API.

## Run

```bash
uv sync
set JWT_SECRET=change_me
set JWT_ALGORITHM=HS256
set REQUEST_TIMEOUT_SECONDS=20
uv run remote-proxy
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
- `GET /manage/agents/stream` (SSE live updates for connect/disconnect)
- `POST /manage/jwt/issue` with `{ "subject": "...", "expiry_minutes": 60, "capabilities": ["*"] }`
- `POST /manage/jwt/revoke` with `{ "token": "..." }`
- `POST /manage/{agent_id}/{mcp_server}/server-info`

For local MCP clients like VS Code, unauthenticated MCP transport can be enabled:
- `ALLOW_UNAUTH_MCP_TRANSPORT=true` (default in this setup)

## One-Command Deploy

Run from `packages/mcp-remote-server`:

```bash
uv run remote-proxy-deploy
```

Optional flags:
- `--host nexus`
- `--remote-dir /home/ubuntu/remote-proxy`
- `--service remote-proxy`
- `--skip-verify`

This command packages local code (excluding `.venv` and `.env*`), uploads to your server, runs `uv sync`, restarts the systemd service, and checks health.
