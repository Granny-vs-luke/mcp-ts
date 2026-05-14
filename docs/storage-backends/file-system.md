---
title: "File System"
sidebarTitle: "File System"
description: "Local persistence using the standard file system."
---

**Perfect for local development with persistent sessions across restarts.**

File storage persists sessions to a JSON file on disk. Ideal for:
- Local development
- Single-instance deployments
- Testing with persistent state
- Environments without Redis

## Configuration

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=file

# File path for session storage (required)
MCP_TS_STORAGE_FILE=./sessions.json
```

## Features

- **Persistent** across application restarts
- **No external dependencies**
- **Human-readable** JSON format
- **Automatic** directory creation

## Usage

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage automatically uses File when MCP_TS_STORAGE_FILE is set
const sessions = await storage.getUserSession('user-123');
console.log('Stored sessions:', sessions);
```

### File Format

```json
[
  {
    "sessionId": "abc123",
    "userId": "user-123",
    "serverId": "server-1",
    "serverName": "My MCP Server",
    "serverUrl": "https://mcp.example.com",
    "callbackUrl": "https://app.com/callback",
    "transportType": "sse",
    "active": true,
    "createdAt": 1706234567890
  }
]
```

## Troubleshooting

### File Storage Not Persisting

```bash
# Check file permissions
ls -la ./sessions.json

# Verify path is writable
touch ./sessions.json

# Check environment variable
echo $MCP_TS_STORAGE_FILE
```
