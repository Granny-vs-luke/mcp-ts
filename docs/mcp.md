---
title: MCP
description: Access mcp-ts documentation directly within your LLM environment.
icon: "puzzle-piece"
---

The `mcp-ts` documentation is available as a Model Context Protocol (MCP) server. This allows AI assistants and IDEs that support MCP to discover, search, and read the documentation directly during a conversation.

### Endpoint URL

The documentation server is hosted at:
`https://api.mcp-assistant.in/mcp`

### How to use

You can add this server to your preferred MCP-compatible client (such as Claude Desktop, Cursor, or VS Code). The server provides tools to:

- **List Documentation**: View the full hierarchy of available guides and concepts.
- **Search Docs**: Perform fuzzy search across all titles and content.
- **Read Content**: Retrieve the full Markdown content of any specific documentation page.

This integration is intended to help the AI maintain accurate context regarding `mcp-ts` without requiring manual copy-pasting of documentation.
