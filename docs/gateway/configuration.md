---
title: "Gateway Configuration"
sidebarTitle: "Configuration"
description: "Configure your local MCP servers for cloud access."
icon: "gear"
---

The MCP Gateway reads its server definitions from a simple JSON configuration file.

### File Location

The configuration file is located at the following path based on your operating system:

- **Windows**: `%USERPROFILE%\.mcpassistant\mcp.json`
- **UNIX/macOS**: `~/.mcpassistant/mcp.json`

### mcp.json Structure

Add your local MCP servers to the `mcpServers` object. The Gateway will automatically discover these when you run the `/start` command.

```json
{
  "mcpServers": {
    "my-local-server": {
      "command": "node",
      "args": ["C:/path/to/server/index.js"]
    }
  }
}
```

Once configured, these servers will be tunneled to secure remote URLs that can be used by cloud clients like **ChatGPT**, **Claude**, and the **MCP Assistant**.
