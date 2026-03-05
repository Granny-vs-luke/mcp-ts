# mcp-local-agent

Async local bridge that connects outbound to the remote MCP bridge over WSS and forwards invoke requests to local MCP servers using the MCP Python client library.

## Run

```bash
pip install -e .
mcp-local-agent
```

`mcp-local-agent` initializes MCP client sessions for configured `mcpServers` (stdio) and opens the outbound bridge connection to the remote server.

Startup token behavior:
- If `AGENT_JWT` is already configured (env or `config.json`), startup continues without prompting.
- If `AGENT_JWT` is missing, the CLI shows a styled prompt and asks you to paste the token.
- If WebSocket auth fails with `HTTP 403`, the CLI asks for a fresh `AGENT_JWT` and retries immediately.
- `AGENT_ID` is auto-derived from JWT claims (or token fingerprint fallback), so no manual `AGENT_ID` prompt.
- Prompted values are saved into resolved `config.json`, so next runs do not ask again.

Terminal UX:
- Branded startup banner (`MCP ASSISTANT PROXY`).
- Progress-style startup logs for MCP server initialization with per-server steps.
- Connection attempt counters for bridge reconnect flow.

Set `START_MCP_SERVERS=false` if you only want the bridge process.

Configuration can be provided through `.env` and/or `config.json`.

Minimal dynamic `.env`:

```env
REMOTE_SERVER_BASE_URL=https://your-remote-domain
AGENT_JWT=your_agent_jwt
```

With this mode:
- `REMOTE_WEBSOCKET_URL` is derived as `wss://.../connect`
- `AGENT_ID` and `CAPABILITIES` are derived from JWT claims (`sub`, `capabilities`) if not explicitly set
- Local MCP calls are handled via MCP client sessions for `mcpServers`

## mcpServers + bridgeserver

You can run MCP servers from config (supergateway-style) and derive local HTTP endpoints:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "supergateway", "--stdio", "npx", "-y", "@modelcontextprotocol/server-filesystem", "--port", "3004"],
      "port": 3004
    }
  }
}
```

Run one server:

```bash
bridgeserver --config ./config.json --name filesystem
```

Run all servers in config:

```bash
bridgeserver --config ./config.json
```

## Streamlit Dashboard

```bash
mcp-local-dashboard
```

Environment variables:
- `LOCAL_DASHBOARD_HOST` (default: `0.0.0.0`)
- `LOCAL_DASHBOARD_PORT` (default: `8502`)

The dashboard shows resolved agent config and can probe local MCP capability endpoints.

Auto-discovery settings:
- `AUTO_DISCOVER_LOCAL_MCP=true` (default)
- `MCP_DISCOVERY_CANDIDATES=http://127.0.0.1:3004/mcp,http://127.0.0.1:8080/mcp`
