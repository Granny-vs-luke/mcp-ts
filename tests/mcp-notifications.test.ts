import { test, expect } from '@playwright/test';
import { MCPClient } from '../src/server/mcp/oauth-client';

test.describe('MCP server notifications', () => {
  test('emits server notifications to connection and notification listeners', () => {
    const client = new MCPClient({
      identity: 'user-1',
      sessionId: 'session-1',
      serverId: 'server-1',
      serverUrl: 'https://example.com/mcp',
      callbackUrl: 'https://example.com/callback',
    });

    const connectionEvents: any[] = [];
    const serverNotifications: any[] = [];

    client.onConnectionEvent((event) => {
      connectionEvents.push(event);
    });

    client.onServerNotification((event) => {
      serverNotifications.push(event);
    });

    (client as any).handleServerNotification({
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        progress: 50,
        total: 100,
        message: 'Half way there',
      },
    });

    expect(connectionEvents).toHaveLength(1);
    expect(connectionEvents[0].type).toBe('server_notification');
    expect(connectionEvents[0].method).toBe('notifications/progress');
    expect(connectionEvents[0].params.message).toBe('Half way there');

    expect(serverNotifications).toHaveLength(1);
    expect(serverNotifications[0].sessionId).toBe('session-1');
    expect(serverNotifications[0].serverId).toBe('server-1');
    expect(serverNotifications[0].method).toBe('notifications/progress');
  });
});
