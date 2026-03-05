# mcpassistant-gateway

Async local bridge that connects outbound to the remote MCP bridge over WSS and forwards invoke requests to local MCP servers using the MCP Python client library.

## Run

```bash
pip install -e .
mcpassistant-gateway
```

`mcpassistant-gateway` initializes MCP client sessions for configured `mcpServers` (stdio) and opens the outbound bridge connection to the remote server.

Startup token behavior:
- If `AGENT_JWT` is already configured (env or `config.json`), startup continues without prompting.
- If `AGENT_JWT` is missing, the CLI shows a styled prompt and asks you to paste the token.
- If WebSocket auth fails with `HTTP 403`, the CLI asks for a fresh `AGENT_JWT` and retries immediately.
- `AGENT_ID` is auto-derived from JWT claims (or token fingerprint fallback), so no manual `AGENT_ID` prompt.
- Prompted values are saved into resolved `config.json`, so next runs do not ask again.

Set `START_MCP_SERVERS=false` if you only want the bridge process.

Configuration can be provided through `.env` and/or `config.json`.

If `config.json` does not exist, it is created automatically on first run with:
- `remote_server_base_url` defaulting to `https://hub.linkos.in/agent`
- a default `mcpServers.filesystem` entry scoped to your current working directory

Minimal dynamic `.env`:

```env
REMOTE_SERVER_BASE_URL=https://your-remote-domain
AGENT_JWT=your_agent_jwt
```

With this mode:
- `REMOTE_WEBSOCKET_URL` is derived as `wss://.../connect`
- `AGENT_ID` and `CAPABILITIES` are derived from JWT claims (`sub`, `capabilities`) if not explicitly set
- Local MCP calls are handled via MCP client sessions for `mcpServers`

## mcpServers + mcpassistant-gateway-bridge

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
mcpassistant-gateway-bridge --config ./config.json --name filesystem
```

Run all servers in config:

```bash
mcpassistant-gateway-bridge --config ./config.json
```


