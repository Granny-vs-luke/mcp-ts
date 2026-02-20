import { test, expect } from '@playwright/test';
import { MultiSessionClient } from '../src/server/mcp/multi-session-client';

test.describe('MultiSessionClient notifications', () => {
  test('disconnect preserves onNotification listeners for reconnect usage', () => {
    const client = new MultiSessionClient('user-1');

    const received: unknown[] = [];
    client.onNotification((event) => {
      received.push(event);
    });

    expect((client as any)._onNotification.listenerCount).toBe(1);

    client.disconnect();

    expect((client as any)._onNotification.listenerCount).toBe(1);

    (client as any)._onNotification.fire({
      sessionId: 's1',
      serverId: 'srv',
      method: 'notifications/progress',
      params: { progress: 1 },
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
  });
});
