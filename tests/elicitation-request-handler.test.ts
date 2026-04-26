import { test, expect } from '@playwright/test';
import { MCPClient, handleElicitationRequestForMcp } from '../src/server/mcp/oauth-client';
import { ElicitationInterruptError } from '../src/shared/errors';

test.describe('handleElicitationRequestForMcp', () => {
  test('rethrows elicitation interrupt errors created by a different bundled entrypoint', async () => {
    const params = {
      mode: 'form' as const,
      message: 'Configure alert',
      requestedSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
        },
      },
    };
    const interrupt = new Error(`Elicitation required: ${params.message}`) as Error & {
      params: typeof params;
    };
    interrupt.name = 'ElicitationInterruptError';
    interrupt.params = params;

    await expect(
      handleElicitationRequestForMcp(params, async () => {
        throw interrupt;
      })
    ).rejects.toBe(interrupt);
  });

  test('rethrows ElicitationInterruptError so AI adapters can render elicitation UI', async () => {
    const params = {
      mode: 'form' as const,
      message: 'Configure alert',
      requestedSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
        },
      },
    };
    const interrupt = new ElicitationInterruptError(params);

    await expect(
      handleElicitationRequestForMcp(params, async () => {
        throw interrupt;
      })
    ).rejects.toBe(interrupt);
  });

  test('returns cancel when the elicitation callback fails generically', async () => {
    await expect(
      handleElicitationRequestForMcp(
        { mode: 'form', message: 'Configure alert' },
        async () => {
          throw new Error('dialog closed');
        }
      )
    ).resolves.toEqual({ action: 'cancel' });
  });

  test('maps accepted form data to MCP content', async () => {
    await expect(
      handleElicitationRequestForMcp(
        { mode: 'form', message: 'Configure alert' },
        async () => ({
          action: 'accept',
          data: { channel: 'email' },
        })
      )
    ).resolves.toEqual({
      action: 'accept',
      content: { channel: 'email' },
    });
  });

  test('callTool throws a captured elicitation interrupt after the MCP request returns cancel output', async () => {
    const params = {
      mode: 'form' as const,
      message: 'Configure alert',
      requestedSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
        },
      },
    };
    const interrupt = new ElicitationInterruptError(params);
    const client = new MCPClient({ identity: 'user', sessionId: 'session' });

    (client as any).client = {
      request: async () => {
        (client as any).pendingElicitationInterrupt = interrupt;
        return {
          content: [{ type: 'text', text: 'Alert configuration dismissed.' }],
        };
      },
    };

    await expect(client.callTool('configure_alert', {})).rejects.toBe(interrupt);
  });

  test('callTool throws a captured elicitation interrupt after the MCP request errors', async () => {
    const params = {
      mode: 'form' as const,
      message: 'Configure alert',
      requestedSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
        },
      },
    };
    const interrupt = new ElicitationInterruptError(params);
    const client = new MCPClient({ identity: 'user', sessionId: 'session' });

    (client as any).client = {
      request: async () => {
        (client as any).pendingElicitationInterrupt = interrupt;
        throw new Error('MCP error -32603: Elicitation required: Configure alert');
      },
    };

    await expect(client.callTool('configure_alert', {})).rejects.toBe(interrupt);
  });
});
