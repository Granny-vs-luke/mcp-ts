# mcp-remote-server

FastAPI service that keeps persistent outbound WebSocket connections from local agents and exposes an HTTP invoke API.

## Run

```bash
pip install -e .
set JWT_SECRET=change_me
set JWT_ALGORITHM=HS256
set REQUEST_TIMEOUT_SECONDS=20
mcp-remote-server
```

The server exposes:
- `GET /healthz`
- `GET /agents`
- `GET /agents/details`
- `WS /connect`
- `POST /{agent_id}/{mcp_server}/mcp` (streamable-http style)
- `POST /{agent_id}/{mcp_server}/sse` (SSE response)

For local MCP clients like VS Code, unauthenticated MCP transport can be enabled:
- `ALLOW_UNAUTH_MCP_TRANSPORT=true` (default in this setup)

## Streamlit Dashboard

```bash
mcp-remote-dashboard
```

Environment variables:
- `REMOTE_PUBLIC_BASE_URL` (default: `http://127.0.0.1:8000`)
- `DASHBOARD_HOST` (default: `0.0.0.0`)
- `DASHBOARD_PORT` (default: `8501`)
- `DASHBOARD_JWT` (optional agent JWT)

The dashboard lists connected agents and capabilities and generates ready-to-copy invoke URLs:
- `https://<remote>/{agent_id}/{mcp_server}/mcp`

It also includes a JWT Generator panel to create agent JWTs directly in the UI, with MCP server scope (`*` or a single server name).
