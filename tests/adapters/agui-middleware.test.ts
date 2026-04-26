import { test, expect } from '@playwright/test';
import { Observable } from 'rxjs';
import { EventType, type AbstractAgent, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { McpMiddleware } from '../../src/adapters/agui-middleware';
import { type AguiTool } from '../../src/adapters/agui-adapter';
import { getElicitationBroker } from '../../src/server/mcp/elicitation-broker';

test.describe('McpMiddleware', () => {
  test('should emit MCP elicitation as a custom AG-UI event and keep the tool pending', async () => {
    const broker = getElicitationBroker();
    broker.clearAll();

    const tools: AguiTool[] = [
      {
        name: 'configure_alert',
        description: 'Configure an alert',
        parameters: {
          type: 'object',
          properties: {},
        },
        handler: async () => {
          const response = await broker.request({
            identity: 'user-1',
            mode: 'form',
            message: 'Configure your monitoring alert settings.',
            requestedSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string', title: 'Notification Channel' },
              },
              required: ['channel'],
            },
          });

          return `Configured ${(response.data as any)?.channel}`;
        },
      },
    ];

    const middleware = new McpMiddleware({
      tools,
      elicitation: { identity: 'user-1' },
    });

    let runCount = 0;
    const next = {
      run(input: RunAgentInput) {
        runCount += 1;
        return new Observable<BaseEvent>((observer) => {
          const anyInput = input as any;

          observer.next({
            type: EventType.RUN_STARTED,
            threadId: anyInput.threadId,
            runId: anyInput.runId,
          } as any);

          if (runCount === 1) {
            observer.next({
              type: EventType.TOOL_CALL_START,
              toolCallId: 'call_1',
              toolCallName: 'configure_alert',
              parentMessageId: 'msg_1',
            } as any);
            observer.next({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: 'call_1',
              delta: '{}',
            } as any);
            observer.next({
              type: EventType.TOOL_CALL_END,
              toolCallId: 'call_1',
            } as any);
          } else {
            observer.next({
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: 'msg_2',
              delta: 'Done',
            } as any);
          }

          observer.next({
            type: EventType.RUN_FINISHED,
            threadId: anyInput.threadId,
            runId: anyInput.runId,
          } as any);
          observer.complete();
        });
      },
    } as AbstractAgent;

    const events: BaseEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      middleware.run({ messages: [] } as any, next).subscribe({
        next: (event) => {
          events.push(event);

          if (event.type === EventType.CUSTOM && (event as any).name === 'mcp_elicitation') {
            broker.respond((event as any).value.elicitationId, {
              action: 'accept',
              data: { channel: 'slack' },
            });
          }
        },
        error: reject,
        complete: resolve,
      });
    });

    const elicitationEvent = events.find(
      (event) => event.type === EventType.CUSTOM && (event as any).name === 'mcp_elicitation'
    ) as any;
    expect(elicitationEvent).toBeTruthy();
    expect(elicitationEvent.value).toEqual(
      expect.objectContaining({
        _mcp_elicitation: true,
        mode: 'form',
        message: 'Configure your monitoring alert settings.',
        toolCallId: 'call_1',
        toolName: 'configure_alert',
      })
    );
    expect(elicitationEvent.value.elicitationId).toMatch(/^elicit_/);

    const toolResult = events.find((event) => event.type === EventType.TOOL_CALL_RESULT) as any;
    expect(toolResult).toEqual(
      expect.objectContaining({
        toolCallId: 'call_1',
        content: 'Configured slack',
      })
    );
    expect(runCount).toBe(2);

    broker.clearAll();
  });
});
