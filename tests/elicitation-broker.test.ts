import { test, expect } from '@playwright/test';
import { getElicitationBroker } from '../src/server/mcp/elicitation-broker';

test.describe('ElicitationBroker', () => {
  test('notifies subscribers and resolves the pending request when the user responds', async () => {
    const broker = getElicitationBroker();
    const seen: unknown[] = [];
    const unsubscribe = broker.subscribe((request) => {
      seen.push(request);
    });

    try {
      const pending = broker.request({
        identity: 'user-1',
        sessionId: 'session-1',
        serverId: 'alerts',
        mode: 'form',
        message: 'Configure alert',
        requestedSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string' },
          },
        },
      });

      expect(seen).toHaveLength(1);
      const request = seen[0] as { elicitationId: string; message: string };
      expect(request.elicitationId).toMatch(/^elicit_/);
      expect(request.message).toBe('Configure alert');

      expect(
        broker.respond(request.elicitationId, {
          action: 'accept',
          data: { channel: 'slack' },
        })
      ).toBe(true);

      await expect(pending).resolves.toEqual({
        action: 'accept',
        data: { channel: 'slack' },
      });
    } finally {
      unsubscribe();
    }
  });
});
