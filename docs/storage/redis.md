---
title: "Redis"
sidebarTitle: "Redis"
description: "High-performance session storage using Redis."
icon: "rocket"
---

**Recommended for production and serverless deployments.**

Redis provides distributed, persistent storage with automatic TTL (Time To Live) management. Perfect for:
- Production environments
- Serverless deployments (Vercel, AWS Lambda)
- Multi-instance applications
- High-availability setups

## Installation

```bash
npm install @mcp-ts/sdk ioredis
```

## Configuration

```bash
# Explicit selection (optional)
MCP_TS_STORAGE_TYPE=redis

# Redis connection URL (required)
REDIS_URL=redis://localhost:6379

# Or for cloud Redis with TLS
REDIS_URL=rediss://default:password@host.upstash.io:6379
```

## Features

- **Automatic session expiration** (12 hours TTL)
- **Atomic operations** for data consistency
- **Distributed storage** across instances
- **Production-ready scalability**

## Usage

```typescript
import { storage } from '@mcp-ts/sdk/server';

// Storage automatically uses Redis when REDIS_URL is set
const sessionId = storage.generateSessionId();

await storage.createSession({
  sessionId,
  identity: 'user-123',
  serverUrl: 'https://mcp.example.com',
  callbackUrl: 'https://app.com/callback',
  transportType: 'sse',
  active: true,
  createdAt: Date.now(),
});
```

## Troubleshooting

### Redis Connection Failed

```bash
# Verify Redis is running
redis-cli ping  # Should return PONG

# Check connection string
echo $REDIS_URL

# Test with redis-cli
redis-cli -u $REDIS_URL ping
```
