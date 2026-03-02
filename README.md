# MCP Bridge Python Monorepo

This repository contains two publishable Python packages under `packages/`:

- `packages/mcp-remote-server` (`mcp-remote-server`): FastAPI cloud bridge.
- `packages/mcp-local-agent` (`mcp-local-agent`): local outbound agent.

## Layout

```text
packages/
  mcp-remote-server/
    pyproject.toml
    src/mcp_remote_server/
  mcp-local-agent/
    pyproject.toml
    src/mcp_local_agent/
```

## 1) Remote Server

```bash
cd packages/mcp-remote-server
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -e .
set JWT_SECRET=replace_with_strong_secret
set JWT_ALGORITHM=HS256
set REQUEST_TIMEOUT_SECONDS=20
set HOST=0.0.0.0
set PORT=8000
mcp-remote-server
```

Endpoints:
- `WS /connect`
- `POST /{agent_id}/{mcp_server}/mcp`
- `POST /{agent_id}/{mcp_server}/sse`
- `GET /agents`
- `GET /agents/details`
- `GET /healthz`

Optional Streamlit dashboard:

```bash
set REMOTE_PUBLIC_BASE_URL=https://your-remote-domain
set DASHBOARD_JWT=agent_jwt
mcp-remote-dashboard
```

The dashboard shows:
- Local agent connection URL (`wss://.../connect`)
- Connected agents + capabilities
- Copyable invoke URLs (`https://.../{agent_id}/{mcp_server}/mcp`)

## 2) Local Agent

Create `packages/mcp-local-agent/config.json`:

```json
{
  "agent_id": "agent-123",
  "remote_server_base_url": "https://your-remote-domain",
  "capabilities": ["filesystem", "postgres"],
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "supergateway", "--stdio", "npx", "-y", "@modelcontextprotocol/server-filesystem", "--port", "3004"],
      "port": 3004
    },
    "postgres": {
      "url": "http://127.0.0.1:9002/mcp"
    }
  },
  "reconnect_initial_delay_seconds": 1,
  "reconnect_max_delay_seconds": 20,
  "request_timeout_seconds": 20
}
```

Run:

```bash
cd packages/mcp-local-agent
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -e .
mcp-local-agent
```

`mcp-local-agent` starts configured `mcpServers` plus the bridge in one command.
Set `START_MCP_SERVERS=false` to run only the bridge.

Optional Streamlit dashboard:

```bash
cd packages/mcp-local-agent
mcp-local-dashboard
```

The dashboard shows:
- Resolved local agent config
- Remote `wss://.../connect` target
- Local MCP endpoint probe status

## 3) JWT Claims

Agent token (`role=agent`):

```json
{
  "sub": "agent-123",
  "role": "agent",
  "capabilities": ["filesystem", "postgres"],
  "exp": 1893456000
}
```

Dashboard/API token (agent role):

```json
{
  "sub": "agent-123",
  "role": "agent",
  "capabilities": ["filesystem"],
  "exp": 1893456000
}
```

## 4) Publish

```bash
cd packages/mcp-remote-server
python -m build

cd ../mcp-local-agent
python -m build
```

Upload with your preferred publisher (e.g. `twine`).
