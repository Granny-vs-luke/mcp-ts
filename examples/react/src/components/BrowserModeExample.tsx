/**
 * BrowserModeExample.tsx
 *
 * Demonstrates the fully browser-side ("no backend") architecture of mcp-ts.
 *
 * In this mode:
 *  - Sessions are stored in window.localStorage via LocalStorageBackend.
 *  - Connections go directly from the browser to the remote MCP server.
 *  - No sseHandler / nextHandlers / Express route is required.
 *
 * Contrast with the proxy mode in App.tsx which uses the useMcp hook + a
 * backend SSE endpoint to keep tokens server-side.
 *
 * ⚠️  Requirements:
 *  - The remote MCP server must have CORS enabled for your origin.
 *  - OAuth tokens will be stored in localStorage (XSS risk — not for high-security prod).
 *
 * ✅  Ideal for:
 *  - Demos, prototypes, developer tools
 *  - Electron / Tauri desktop apps
 *  - SPAs that don't want any backend infrastructure
 */

import { useEffect, useMemo, useState, useCallback } from 'react';

// ── LocalStorageBackend lives in the /client entry point (no Node.js imports) ──
import { LocalStorageBackend } from '@mcp-ts/sdk/client';

// ── MCPClient / MultiSessionClient are isomorphic — they work in the browser
//    when you inject a browser-safe storage backend via the `storage` option. ──
import { MultiSessionClient, MCPClient } from '@mcp-ts/sdk/server';
import type { StorageBackend } from '@mcp-ts/sdk/shared';

// ─── Singleton storage — one instance per page load ──────────────────────────
const browserStorage: StorageBackend = new LocalStorageBackend({
  namespace: 'mcp-ts-react-example',
  defaultTtl: 43200, // 12 hours
});

let storageReady = false;

async function ensureStorage() {
  if (!storageReady) {
    await browserStorage.init();
    storageReady = true;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ConnectionInfo {
  sessionId: string;
  serverUrl: string;
  serverName?: string;
  connected: boolean;
  tools: string[];
}

export function BrowserModeExample() {
  const [serverUrl, setServerUrl] = useState('https://my-mcp-server.example.com/mcp');
  const [callbackUrl, setCallbackUrl] = useState(`${window.location.origin}/oauth/callback`);
  const [serverName, setServerName] = useState('My MCP Server');
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Create a MultiSessionClient that uses localStorage for session discovery
  const multiClient = useMemo(
    () => new MultiSessionClient('browser-user', { storage: browserStorage }),
    []
  );

  // On mount: initialize storage and reconnect previously saved sessions
  useEffect(() => {
    ensureStorage().then(() => {
      setStatus('loading');
      multiClient
        .connect()
        .then(() => {
          const clients = multiClient.getClients();
          setConnections(
            clients.map((c) => ({
              sessionId: c.getSessionId(),
              serverUrl: c.getServerUrl(),
              serverName: c.getServerName(),
              connected: c.isConnected(),
              tools: [],
            }))
          );
          setStatus('idle');
        })
        .catch((err) => {
          setErrorMsg(String(err));
          setStatus('error');
        });
    });

    return () => {
      multiClient.disconnect();
    };
  }, [multiClient]);

  // Connect to a new MCP server using LocalStorageBackend via DI
  const handleConnect = useCallback(async () => {
    setStatus('loading');
    setErrorMsg(null);

    try {
      await ensureStorage();

      const sessionId = browserStorage.generateSessionId();

      const client = new MCPClient({
        identity: 'browser-user',
        sessionId,
        serverUrl,
        serverName,
        callbackUrl,
        // ✅  Inject the browser-safe storage backend
        storage: browserStorage,
      });

      await client.connect();

      setConnections((prev) => [
        ...prev,
        {
          sessionId,
          serverUrl,
          serverName,
          connected: client.isConnected(),
          tools: [],
        },
      ]);
    } catch (err: any) {
      setErrorMsg(err?.message ?? String(err));
    } finally {
      setStatus('idle');
    }
  }, [serverUrl, serverName, callbackUrl]);

  return (
    <div style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif', maxWidth: 640 }}>
      <h2>Browser Mode (LocalStorage)</h2>
      <p style={{ color: '#555', fontSize: '0.875rem' }}>
        This example connects directly from the browser to a remote MCP server.
        No backend SSE endpoint is required — sessions are persisted in{' '}
        <code>window.localStorage</code>.
      </p>

      {/* ── Connection form ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
        <input
          value={serverName}
          onChange={(e) => setServerName(e.target.value)}
          placeholder="Server name"
          style={inputStyle}
        />
        <input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="MCP server URL"
          style={inputStyle}
        />
        <input
          value={callbackUrl}
          onChange={(e) => setCallbackUrl(e.target.value)}
          placeholder="OAuth callback URL"
          style={inputStyle}
        />
        <button
          onClick={handleConnect}
          disabled={status === 'loading'}
          style={buttonStyle}
        >
          {status === 'loading' ? 'Connecting…' : 'Connect'}
        </button>
      </div>

      {/* ── Error display ── */}
      {errorMsg && (
        <p style={{ color: '#c00', background: '#fee', padding: '0.5rem', borderRadius: 4 }}>
          {errorMsg}
        </p>
      )}

      {/* ── Active connections ── */}
      <h3>Active connections ({connections.length})</h3>
      {connections.length === 0 ? (
        <p style={{ color: '#888' }}>No connections yet. Connect to an MCP server above.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {connections.map((conn) => (
            <li
              key={conn.sessionId}
              style={{
                border: '1px solid #ddd',
                borderRadius: 6,
                padding: '0.75rem',
                marginBottom: '0.5rem',
              }}
            >
              <strong>{conn.serverName ?? conn.serverUrl}</strong>
              <span
                style={{
                  marginLeft: 8,
                  color: conn.connected ? 'green' : 'orange',
                  fontSize: '0.8rem',
                }}
              >
                ● {conn.connected ? 'Connected' : 'Disconnected'}
              </span>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#666' }}>
                Session: <code>{conn.sessionId}</code>
              </p>
            </li>
          ))}
        </ul>
      )}

      <details style={{ marginTop: '1rem', fontSize: '0.8rem', color: '#888' }}>
        <summary>How does this work?</summary>
        <pre
          style={{
            background: '#f5f5f5',
            padding: '0.75rem',
            borderRadius: 4,
            overflowX: 'auto',
          }}
        >
          {`import { LocalStorageBackend } from '@mcp-ts/sdk/client';
import { MCPClient } from '@mcp-ts/sdk/server';

const storage = new LocalStorageBackend({ namespace: 'my-app' });
await storage.init();

const client = new MCPClient({
  identity: 'browser-user',
  sessionId: storage.generateSessionId(),
  serverUrl: 'https://mcp.example.com/mcp',
  callbackUrl: window.location.origin + '/callback',
  storage, // ← same backend injected here
});

await client.connect();`}
        </pre>
      </details>
    </div>
  );
}

// ─── Tiny inline styles ───────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.9rem',
  width: '100%',
  boxSizing: 'border-box',
};

const buttonStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: '#0070f3',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.9rem',
};
