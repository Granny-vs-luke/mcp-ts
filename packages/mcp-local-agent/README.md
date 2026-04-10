# mcpassistant-gateway

Async local bridge that connects outbound to the remote MCP bridge over WSS and forwards invoke requests to local MCP servers using the MCP Python client library.

## Run

```bash
pip install -e .
mcpassistant-gateway
```

`mcpassistant-gateway` now opens an interactive menu by default.
Use `/start` inside the menu to start the gateway in the background.
Use `/logs on` only when you want to inspect realtime logs.
Press `Ctrl+C` while running to stop and return to the menu.

You can also use the built-in CLI helpers instead of editing `mcp.json` manually:

```bash
mcpassistant-gateway run
mcpassistant-gateway menu
mcpassistant-gateway settings
mcpassistant-gateway config show
mcpassistant-gateway config set --request-timeout-seconds 120
mcpassistant-gateway run --request-timeout-seconds 120
```

Inside `mcpassistant-gateway menu`, use slash commands:

```text
/help
/login
/logout
/show
/set request_timeout_seconds 120
/settings
/run
```

`/login` behavior:
- OAuth-first: starts remote OAuth session, opens browser, receives localhost callback, exchanges code, and saves JWT on success.
- Legacy fallback: if OAuth endpoints are unavailable, falls back to `POST /manage/jwt/issue`.

For OAuth localhost callback, ensure your auth provider allows:
- `http://127.0.0.1:43110/callback`

`mcpassistant-gateway` initializes MCP client sessions for configured `mcpServers` (stdio) and opens the outbound bridge connection to the remote server.

Startup token behavior:
- If `AGENT_JWT` is already configured (env or runtime state), startup continues without prompting.
- If `AGENT_JWT` is missing, the CLI shows a styled prompt and asks you to paste the token.
- If WebSocket auth fails with `HTTP 403`, the CLI asks for a fresh `AGENT_JWT` and retries immediately.
- `AGENT_ID` is auto-derived from JWT claims (or token fingerprint fallback), so no manual `AGENT_ID` prompt.
- Prompted values are saved into the runtime state file, so next runs do not ask again.

Set `START_MCP_SERVERS=false` if you only want the bridge process.

Configuration can be provided through `.env`, runtime state, and `mcp.json`.

If `mcp.json` does not exist, it is created automatically on first run at `.mcpassistant/mcp.json` with:
- only an `mcpServers` object
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

## Troubleshooting: Gemini CLI

Gemini CLI uses the official MCP Streamable HTTP transport (`@modelcontextprotocol/sdk`).
Some versions may try to open an **optional GET SSE stream** by sending:

- `GET <httpUrl>` with `Accept: text/event-stream`

If your remote proxy responds with a short-lived SSE payload (instead of a real long-lived MCP message stream),
Gemini may mark the server as **Disconnected**.

Fix:
- Ensure your remote proxy supports a proper long-lived MCP SSE message stream on `GET /mcp`
  when `Accept: text/event-stream`, and make sure your reverse proxy does not buffer the stream.

Gemini CLI config should use `httpUrl` (streamable HTTP), pointing at the `/mcp` endpoint:

```json
{
  "mcpServers": {
    "filesystem": {
      "httpUrl": "https://<your-host>/<subject>/filesystem/mcp",
      "timeout": 30000
    }
  }
}
```

If your server requires auth, add headers (Gemini supports custom headers per server).

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
mcpassistant-gateway-bridge --config ./.mcpassistant/mcp.json --name filesystem
```

Run all servers in config:

```bash
mcpassistant-gateway-bridge --config ./.mcpassistant/mcp.json
```


