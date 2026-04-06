/**
 * MCP Apps Hook
 *
 * Provides utilities for rendering interactive UI components from MCP servers.
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  memo,
  useMemo,
  type MutableRefObject,
} from 'react';
import { useAppHost } from './use-app-host.js';
import type { SSEClient } from '../core/sse-client.js';

export interface McpClient {
  connections: Array<{
    sessionId: string;
    tools: Array<{
      name: string;
      mcpApp?: {
        resourceUri: string;
      };
      _meta?: {
        ui?: {
          resourceUri?: string;
        };
        'ui/resourceUri'?: string;
      };
    }>;
  }>;
  sseClient?: SSEClient | null;
}

export interface McpAppMetadata {
  toolName: string;
  resourceUri: string;
  sessionId: string;
}

/** Props for {@link useMcpApps}'s `McpAppRenderer` (client is supplied via the hook). */
export interface McpAppRendererProps {
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  status: 'executing' | 'inProgress' | 'complete' | 'idle';
  /** Custom CSS class for the container */
  className?: string;
}

type McpAppViewProps = McpAppRendererProps & {
  /**
   * Ref avoids tying `McpAppRenderer` identity to `mcpClient`: when `connections` updates, `useMcp()` still
   * returns a new object (correct for `useEffect` deps), but the iframe must not remount.
   */
  clientRef: MutableRefObject<McpClient | null>;
};

/** Renders one MCP App in a sandboxed iframe; reads the latest client from `clientRef` each render. */
const McpAppView = memo(function McpAppView({
  clientRef,
  name,
  input,
  result,
  status,
  className,
}: McpAppViewProps) {
  const mcpClient = clientRef.current;
  const metadata = getMcpAppMetadata(mcpClient, name);
  const sseClient = mcpClient?.sseClient ?? null;
  const resourceUri = metadata?.resourceUri;
  const appSessionId = metadata?.sessionId;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { host, error: hostError } = useAppHost(sseClient as SSEClient, iframeRef);
  const [isLaunched, setIsLaunched] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const sentInputRef = useRef(false);
  const sentResultRef = useRef(false);
  const lastInputRef = useRef(input);
  const lastResultRef = useRef(result);
  const lastStatusRef = useRef(status);

  useEffect(() => {
    setIsLaunched(false);
    setError(null);
  }, [resourceUri, appSessionId]);

  useEffect(() => {
    if (!host || !resourceUri || !appSessionId) return;

    host
      .launch(resourceUri, appSessionId)
      .then(() => setIsLaunched(true))
      .catch((err) => setError(err instanceof Error ? err : new Error(String(err))));
  }, [host, resourceUri, appSessionId]);

  useEffect(() => {
    if (!host || !isLaunched || !resourceUri || !appSessionId || !input) return;

    if (!sentInputRef.current || JSON.stringify(input) !== JSON.stringify(lastInputRef.current)) {
      sentInputRef.current = true;
      lastInputRef.current = input;
      host.sendToolInput(input);
    }
  }, [host, isLaunched, input, resourceUri, appSessionId, name]);

  useEffect(() => {
    if (!host || !isLaunched || !resourceUri || !appSessionId || result === undefined) return;
    if (status !== 'complete') return;

    if (!sentResultRef.current || JSON.stringify(result) !== JSON.stringify(lastResultRef.current)) {
      sentResultRef.current = true;
      lastResultRef.current = result;
      const formattedResult =
        typeof result === 'string'
          ? { content: [{ type: 'text', text: result }] }
          : result;
      host.sendToolResult(formattedResult);
    }
  }, [host, isLaunched, result, status, resourceUri, appSessionId, name]);

  useEffect(() => {
    if (status === 'executing' && lastStatusRef.current !== 'executing') {
      sentInputRef.current = false;
      sentResultRef.current = false;
    }
    lastStatusRef.current = status;
  }, [status]);

  if (!metadata || !sseClient) {
    return null;
  }

  const displayError = error || hostError;
  if (displayError) {
    return (
      <div className={`p-4 bg-red-900/20 border border-red-700 rounded text-red-200 ${className || ''}`}>
        Error: {displayError.message || String(displayError)}
      </div>
    );
  }

  return (
    <div className={`w-full border border-gray-700 rounded overflow-hidden bg-white min-h-96 my-2 relative ${className || ''}`}>
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        className="w-full h-full min-h-96"
        style={{ height: 'auto' }}
        title="MCP App"
      />
      {!isLaunched && (
        <div className="absolute inset-0 bg-gray-900/50 flex items-center justify-center pointer-events-none">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
});

/**
 * Helpers scoped to one `mcpClient`. Pass the client here once; `McpAppRenderer` only needs per-tool props (`name`, `input`, `result`, `status`).
 *
 * @param mcpClient - From `useMcp()` or context (for example `useMcpContext()`).
 */
export function useMcpApps(mcpClient: McpClient | null) {
  // Stable `McpAppRenderer` type: parent re-renders and `connections` updates must not remount the iframe.
  const clientRef = useRef(mcpClient);
  clientRef.current = mcpClient;

  const getAppMetadata = useCallback(
    (toolName: string) => getMcpAppMetadata(clientRef.current, toolName),
    []
  );

  const McpAppRenderer = useMemo(() => {
    const Renderer = memo(function McpAppRenderer(props: McpAppRendererProps) {
      return <McpAppView clientRef={clientRef} {...props} />;
    });
    Renderer.displayName = 'McpAppRenderer';
    return Renderer;
  }, []);

  return { getAppMetadata, McpAppRenderer };
}

function extractToolName(fullName: string): string {
  const match = fullName.match(/(?:tool_[^_]+_)?(.+)$/);
  return match?.[1] || fullName;
}

function getMcpAppMetadata(
  mcpClient: McpClient | null,
  toolName: string
): McpAppMetadata | undefined {
  if (!mcpClient) return undefined;

  const extractedName = extractToolName(toolName);

  for (const conn of mcpClient.connections) {
    for (const tool of conn.tools) {
      const candidateName = extractToolName(tool.name);
      const resourceUri =
        tool.mcpApp?.resourceUri ??
        tool._meta?.ui?.resourceUri ??
        tool._meta?.['ui/resourceUri'];

      if (resourceUri && candidateName === extractedName) {
        return {
          toolName: candidateName,
          resourceUri,
          sessionId: conn.sessionId,
        };
      }
    }
  }

  return undefined;
}
