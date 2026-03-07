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
- `POST /{subject}/{mcp_server}/mcp` (streamable-http style)
- `POST /{subject}/{mcp_server}/sse` (SSE response)

Management endpoints:
- `GET /manage/agents/details`
- `GET /manage/agents/stream` (SSE live updates for connect/disconnect)
- `POST /manage/jwt/issue` with `{ "subject": "...", "expiry_minutes": 60, "capabilities": ["*"] }`
- `POST /manage/jwt/revoke` with `{ "token": "..." }`
- `POST /manage/oauth/start` with `{ "subject": "...", "expiry_minutes": 60, "capabilities": ["*"] }`
- `GET /manage/oauth/callback` (browser OAuth redirect target)
- `GET /manage/oauth/status?session_id=...`
- `POST /manage/oauth/complete` with `{ "state": "...", "code": "..." }`
- `POST /manage/{subject}/{mcp_server}/server-info`

For local MCP clients like VS Code, unauthenticated MCP transport can be enabled:
- `ALLOW_UNAUTH_MCP_TRANSPORT=true` (default in this setup)

Supabase OAuth environment (optional, enables browser `/login` from local-agent menu):
- `SUPABASE_URL=https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY=<supabase_anon_or_publishable_key>`
- `SUPABASE_OAUTH_PROVIDER=google` (or github, etc.)
- `OAUTH_PUBLIC_BASE_URL=https://<your-remote-host>` (for callback URL generation)
- `OAUTH_ALLOWED_EMAIL_DOMAINS=example.com,another.com` (optional allowlist)

## One-Command Deploy

Run from `packages/mcp-remote-server`:

```bash
uv run remote-proxy-deploy
```

Optional flags:
- `--host nexus`
- `--remote-dir /home/ubuntu/mcp-remote-server`
- `--service mcp-remote-server`
- `--skip-verify`
- `--env-file .env.production` (uploads this file as remote `.env` before restart)

This command packages local code (excluding `.venv` and `.env*`), uploads to your server, runs `uv sync`, restarts the systemd service, and checks health.
