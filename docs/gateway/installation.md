---
title: Installation
description: Get up and running with the MCP Gateway in seconds.
---

The MCP Gateway is distributed as a lightweight CLI tool. The easiest way to run it is using `uv`.

### Run via uvx

To launch the gateway shell without a manual installation, run:

```bash
uvx mcpassistant-gateway
```

### Initial Setup

Once the shell is open, follow these steps to initialize your bridge:

1. **Authentication**: Use the `/logout` or `/login` flow to ensure you are connected to your MCP Assistant account.
2. **Launch Bridge**: Run the `/start` command to initialize the tunnels for your locally configured servers.

```bash
mcp > /start
[1/1] 'filesystem' ↣ initializing...
```

Use `/help` at any time within the shell to see the full list of available commands.
