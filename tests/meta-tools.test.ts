import { test, expect } from '@playwright/test';
import { executeMetaTool } from '../src/shared/meta-tools';
import { ElicitationInterruptError } from '../src/shared/errors';

test.describe('executeMetaTool', () => {
    test('should return structured errors for ambiguous schema lookup', async () => {
        const router = {
            getToolSchema: () => {
                throw new Error('Tool "duplicate_tool" is provided by multiple servers. Please specify the desired "serverName" as a namespace.');
            },
        };

        const result = await executeMetaTool(
            'mcp_get_tool_schema',
            { toolName: 'duplicate_tool' },
            router as any
        );

        expect(result?.isError).toBe(true);
        expect((result?.content[0] as any).text).toContain('serverName');
    });

    test('should return structured errors for ambiguous tool execution lookup', async () => {
        const router = {
            getToolSchema: () => {
                throw new Error('Tool "duplicate_tool" is provided by multiple servers. Please specify the desired "serverName" as a namespace.');
            },
        };

        const result = await executeMetaTool(
            'mcp_execute_tool',
            { toolName: 'duplicate_tool', args: {} },
            router as any,
            async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })
        );

        expect(result?.isError).toBe(true);
        expect((result?.content[0] as any).text).toContain('serverName');
    });

    test('should rethrow elicitation interrupts from proxied tool execution', async () => {
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
        const router = {
            getToolSchema: () => ({
                name: 'configure_alert',
                description: 'Configure a monitoring alert',
                inputSchema: { type: 'object', properties: {} },
            }),
        };

        await expect(
            executeMetaTool(
                'mcp_execute_tool',
                { toolName: 'configure_alert', args: {} },
                router as any,
                async () => {
                    throw interrupt;
                }
            )
        ).rejects.toBe(interrupt);
    });

    test('should rethrow elicitation interrupts created by a different bundled entrypoint', async () => {
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
        const router = {
            getToolSchema: () => ({
                name: 'configure_alert',
                description: 'Configure a monitoring alert',
                inputSchema: { type: 'object', properties: {} },
            }),
        };

        await expect(
            executeMetaTool(
                'mcp_execute_tool',
                { toolName: 'configure_alert', args: {} },
                router as any,
                async () => {
                    throw interrupt;
                }
            )
        ).rejects.toBe(interrupt);
    });
});
