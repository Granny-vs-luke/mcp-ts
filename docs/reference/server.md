---
title: "Server-Side API"
sidebarTitle: "Server-Side"
description: "API reference for mcp-ts server-side primitives, including MultiSessionClient, SSEClient, framework handlers, and adapters for AI SDK, LangChain, and Mastra."
icon: "server"
---

### `createNextMcpHandler(options)`

Creates handlers for Next.js App Router API routes.

```typescript
import { createNextMcpHandler } from '@mcp-ts/sdk/server';

const { GET, POST } = createNextMcpHandler({
  getUserId: (request) => string,
  getAuthToken?: (request) => string | null,
  authenticate?: (userId, token) => Promise<boolean>,
  heartbeatInterval?: number,
});
```

**Options:**
- `getUserId` - Function to extract userId from request (required)
- `getAuthToken` - Function to extract auth token from request (optional)
- `authenticate` - Custom authentication logic (optional)
- `heartbeatInterval` - SSE heartbeat interval in ms (default: 30000)
- `clientDefaults` - Static OAuth client metadata (optional)
- `getClientMetadata` - Dynamic OAuth metadata getter (optional, overrides defaults)

**Returns:** `{ GET, POST }` - HTTP method handlers

---

### `createSSEHandler(options)`

Creates an SSE handler for standard Node.js/Express applications.

```typescript
import { createSSEHandler } from '@mcp-ts/sdk/server';

const handler = createSSEHandler({
  userId: string,
  onAuth?: (userId) => Promise<boolean>,
  heartbeatInterval?: number,
});
```

**Options:**
- `userId` - User/Client identifier (required)
- `onAuth` - Authentication callback (optional)
- `heartbeatInterval` - Heartbeat interval in ms (default: 30000)
- `clientDefaults` - Static OAuth client metadata (optional)
- `getClientMetadata` - Dynamic OAuth metadata getter (optional)

**Returns:** Request handler function

---

### `MCPClient`

Direct MCP client class for server-side operations.

```typescript
import { MCPClient } from '@mcp-ts/sdk/server';

const client = new MCPClient({
  userId: string,
  sessionId: string,
  serverId?: string,
  serverUrl?: string,
  callbackUrl?: string,
  transportType?: 'sse' | 'streamable-http',
  onRedirect?: (authUrl: string) => void,
  // OAuth Metadata
  clientName?: string,
  clientUri?: string,
  logoUri?: string,
  policyUri?: string,
});
```

#### Methods

**`connect(): Promise<void>`**

Connect to the MCP server. May throw `UnauthorizedError` if OAuth is required.

```typescript
await client.connect();
```

---

**`disconnect(): Promise<void>`**

Disconnect from the MCP server.

```typescript
await client.disconnect();
```

---

**`listTools(): Promise<ListToolsResult>`**

List available tools from the MCP server.

```typescript
const { tools } = await client.listTools();
```

---

**`callTool(name: string, args: object): Promise<CallToolResult>`**

Call a tool with arguments.

```typescript
const result = await client.callTool('get_weather', {
  location: 'San Francisco',
});
```

---

**`getAITools(): Promise<ToolSet>`**

Get all MCP tools and convert them to AI SDK compatible tools.

```typescript
const tools = await client.getAITools();
```

---


**`listPrompts(): Promise<ListPromptsResult>`**

List available prompts.

```typescript
const { prompts } = await client.listPrompts();
```

---

**`getPrompt(name: string, args?: object): Promise<GetPromptResult>`**

Get a prompt with optional arguments.

```typescript
const prompt = await client.getPrompt('code-review', {
  language: 'typescript',
});
```

---

**`listResources(): Promise<ListResourcesResult>`**

List available resources.

```typescript
const { resources } = await client.listResources();
```

---

**`readResource(uri: string): Promise<ReadResourceResult>`**

Read a specific resource by URI.

```typescript
const resource = await client.readResource('file:///path/to/file');
```

---

**`finishAuth(code: string): Promise<void>`**

Complete OAuth authorization with authorization code.

```typescript
await client.finishAuth(authCode);
```

---

### `MultiSessionClient`

Manages multiple MCP connections for a single user, allowing aggregation of tools from all connected servers.

```typescript
import { MultiSessionClient } from '@mcp-ts/sdk/server';

const mcp = new MultiSessionClient(userId, {
  timeout: 15000,
  maxRetries: 2,
  retryDelay: 1000,
});
```

**Options:**
- `timeout` - Connection timeout in milliseconds (default: 15000)
- `maxRetries` - Maximum number of retry attempts for each session (default: 2)
- `retryDelay` - Delay between retries in milliseconds (default: 1000)

#### Methods

**`connect(): Promise<void>`**

Connects to all active sessions for the user. Skips sessions that fail to connect after retries, but logs errors.

```typescript
await mcp.connect();
```

---

**`getClients(): MCPClient[]`**

Returns the array of currently connected clients.

```typescript
const clients = mcp.getClients();
```

---

**`disconnect(): void`**

Disconnects all active clients and clears the internal client list.

```typescript
mcp.disconnect();
```

---
