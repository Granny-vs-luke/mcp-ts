import { useState } from 'react';
import { useMcp } from '@mcp-ts/sdk/client';
import ConnectionList from './components/ConnectionList';
import ConnectForm from './components/ConnectForm';
import './App.css';

function App() {
  const [sseUrl] = useState('https://mcp.deepwiki.com/mcp');
  const [identity] = useState('test-user'); // In production, get from your auth system
  const [authToken] = useState(''); // In production, get from your auth system

  const {
    connections,
    status,
    connect,
    disconnect,
  } = useMcp({
    url: sseUrl,
    identity,
    authToken,
    autoConnect: true,
  });

  return (
    <div className="app">
      <header>
        <h1>MCP Client Example</h1>
        <div className="status-badge" data-status={status}>
          SSE Status: {status}
        </div>
      </header>

      <main>
        <section className="connect-section">
          <h2>Connect to MCP Server</h2>
          <ConnectForm
            onConnect={connect}
          />
        </section>

        <section className="connections-section">
          <h2>Active Connections ({connections.length})</h2>
          <ConnectionList
            connections={connections}
            onDisconnect={disconnect}
          />
        </section>

        <section className="info-section">
          <h3>About this Example</h3>
          <p>
            This example demonstrates the <code>useMcp</code> hook from{' '}
            <code>@mcp-ts/sdk</code>. It connects to an MCP server via Server-Sent
            Events (SSE) through a backend proxy that handles session persistence.
          </p>
          <h4>Proxy Mode (this example):</h4>
          <ul>
            <li>Real-time connection status via SSE</li>
            <li>OAuth 2.1 authentication flow</li>
            <li>Tool discovery and execution</li>
            <li>Automatic reconnection handling</li>
            <li>Server-side session persistence (Redis / Supabase / SQLite / File)</li>
          </ul>
          <h4>Browser Mode (no backend):</h4>
          <p style={{ fontSize: '0.875rem', color: '#666' }}>
            For pure browser apps, import <code>LocalStorageBackend</code> from{' '}
            <code>@mcp-ts/sdk/client</code> and pass it to{' '}
            <code>MCPClient</code> or <code>MultiSessionClient</code> via the{' '}
            <code>storage</code> option — no SSE endpoint needed.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
