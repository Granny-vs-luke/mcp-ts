import { test, expect } from '@playwright/test';
import { executeMetaTool } from '../src/shared/meta-tools';

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
});
