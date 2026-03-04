/**
 * Next.js App Router Handler for MCP SSE
 * Provides a clean, zero-boilerplate API for Next.js applications
 */

import { SSEConnectionManager, type ClientMetadata } from './sse-handler.js';
import type { McpConnectionEvent, McpObservabilityEvent } from '../../shared/events.js';
import type { McpRpcResponse } from '../../shared/types.js';

export interface NextMcpHandlerOptions {
  /**
   * Extract identity from request (default: from 'identity' query param)
   */
  getIdentity?: (request: Request) => string | null;

  /**
   * Extract auth token from request (default: from 'token' query param or Authorization header)
   */
  getAuthToken?: (request: Request) => string | null;

  /**
   * Authenticate user and verify access (optional)
   * Return true if user is authenticated, false otherwise
   */
  authenticate?: (identity: string, token: string | null) => Promise<boolean> | boolean;

  /**
   * Heartbeat interval in milliseconds (default: 30000)
   */
  heartbeatInterval?: number;

  /**
   * Static OAuth client metadata defaults (for all connections)
   * Use this for single-tenant applications with fixed branding
   */
  clientDefaults?: ClientMetadata;

  /**
   * Dynamic OAuth client metadata getter (per-request, useful for multi-tenant)
   * Use this when you need different branding based on request (tenant, domain, etc.)
   * Takes precedence over clientDefaults
   */
  getClientMetadata?: (request: Request) => ClientMetadata | Promise<ClientMetadata>;
}

type EventSink = (event: string, data: unknown) => void;
type ManagerEntry = {
  manager: SSEConnectionManager;
  setSink: (sink: EventSink) => void;
  clearSink: () => void;
};

// Global manager store - shared across requests for the same user
const managerEntries = new Map<string, ManagerEntry>();

/**
 * Creates Next.js App Router handlers (GET and POST) for MCP SSE endpoint
 *
 * @example
 * ```typescript
 * // app/api/mcp/route.ts
 * import { createNextMcpHandler } from '@mcp-ts/core/server';
 *
 * export const { GET, POST } = createNextMcpHandler();
 * ```
 */
export function createNextMcpHandler(options: NextMcpHandlerOptions = {}) {
  const {
    getIdentity = (request: Request) => new URL(request.url).searchParams.get('identity'),
    getAuthToken = (request: Request) => {
      const url = new URL(request.url);
      return url.searchParams.get('token') || request.headers.get('authorization');
    },
    authenticate = () => true,
    heartbeatInterval = 30000,
    clientDefaults,
    getClientMetadata,
  } = options;

  function createManagerEntry(identity: string, resolvedClientMetadata?: ClientMetadata): ManagerEntry {
    let sink: EventSink = () => { };

    const manager = new SSEConnectionManager(
      {
        identity,
        heartbeatInterval,
        clientDefaults: resolvedClientMetadata,
      },
      (event: McpConnectionEvent | McpObservabilityEvent | McpRpcResponse) => {
        // POST returns RPC response directly, do not echo over SSE.
        if ('id' in event) {
          return;
        }
        if ('type' in event && 'sessionId' in event) {
          sink('connection', event);
        } else {
          sink('observability', event);
        }
      }
    );

    return {
      manager,
      setSink: (nextSink: EventSink) => {
        sink = nextSink;
      },
      clearSink: () => {
        sink = () => { };
      },
    };
  }

  async function getOrCreateManagerEntry(identity: string, request?: Request): Promise<ManagerEntry> {
    const existing = managerEntries.get(identity);
    if (existing) return existing;

    const resolvedClientMetadata = request
      ? (getClientMetadata ? await getClientMetadata(request) : clientDefaults)
      : clientDefaults;

    const created = createManagerEntry(identity, resolvedClientMetadata);
    managerEntries.set(identity, created);
    return created;
  }

  /**
   * GET handler - Establishes SSE connection
   */
  async function GET(request: Request): Promise<Response> {
    const identity = getIdentity(request);
    const authToken = getAuthToken(request);

    if (!identity) {
      return new Response('Missing identity', { status: 400 });
    }

    // Validate auth
    const isAuthorized = await authenticate(identity, authToken);
    if (!isAuthorized) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Create TransformStream for SSE
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    let streamWritable = true;

    // Helper to send SSE events
    const sendSSE = (event: string, data: any) => {
      if (!streamWritable) return;
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      try {
        writer.write(encoder.encode(message)).catch(() => {
          streamWritable = false;
        });
      } catch {
        streamWritable = false;
      }
    };

    const entry = await getOrCreateManagerEntry(identity, request);
    entry.setSink(sendSSE);

    // Send connected event AFTER manager is registered (prevents race condition
    // where client sends POST before manager is available)
    sendSSE('connected', { timestamp: Date.now() });

    // Handle client disconnect
    request.signal?.addEventListener('abort', () => {
      streamWritable = false;
      entry.clearSink();
      writer.close().catch(() => { });
    });

    // Return SSE response
    return new Response(stream.readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  /**
   * POST handler - Handles RPC requests
   */
  async function POST(request: Request): Promise<Response> {
    const identity = getIdentity(request);
    const authToken = getAuthToken(request);

    if (!identity) {
      return Response.json({ error: { code: 'MISSING_IDENTITY', message: 'Missing identity' } }, { status: 400 });
    }

    // Validate auth
    const isAuthorized = await authenticate(identity, authToken);
    if (!isAuthorized) {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
    }

    let rawBody = '';
    try {
      rawBody = await request.text();
      const body = rawBody ? JSON.parse(rawBody) : null;

      if (!body || typeof body !== 'object') {
        return Response.json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid JSON-RPC request body',
          },
        }, { status: 400 });
      }

      const entry = await getOrCreateManagerEntry(identity);
      // Handle the request and return response directly (bypasses SSE latency)
      const response = await entry.manager.handleRequest(body as any);

      // Return the actual RPC response for immediate use by client
      return Response.json(response);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      console.error('[MCP Next Handler] Failed to handle RPC', {
        identity,
        message: err.message,
        stack: err.stack,
        rawBody: rawBody.slice(0, 500),
      });
      return Response.json(
        {
          error: {
            code: 'EXECUTION_ERROR',
            message: err.message,
          },
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
