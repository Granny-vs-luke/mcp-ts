import { test, expect } from '@playwright/test';
import {
    createListServersToolDefinition,
    createSearchToolDefinition,
    executeMetaTool,
    isMetaTool,
} from '../src/shared/meta-tools';
import { ToolRouter } from '../src/shared/tool-router';

function createRouterClient(
    serverId: string,
    serverName: string,
    tools: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    }>
) {
    return {
        isConnected: () => true,
        getServerId: () => serverId,
        getServerName: () => serverName,
        getSessionId: () => `${serverId}-session`,
        listTools: async () => ({
            tools: tools.map((tool) => ({
                inputSchema: { type: 'object' as const, properties: {} },
                ...tool,
            })),
        }),
        callTool: async (name: string, args: Record<string, unknown>) => ({
            content: [{ type: 'text' as const, text: `${serverName}:${name}:${JSON.stringify(args)}` }],
            isError: false,
        }),
    };
}

test.describe('executeMetaTool', () => {
    test('should expose the generic search tools meta-tool name', async () => {
        expect(createSearchToolDefinition().name).toBe('mcp_search_tools');
        expect(createListServersToolDefinition().name).toBe('mcp_list_servers');
        expect(isMetaTool('mcp_search_tools')).toBe(true);
        expect(isMetaTool('mcp_list_servers')).toBe(true);
    });

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

    test('should tell the model to execute discovered tools via mcp_execute_tool', async () => {
        const router = {
            getToolSchema: () => ({
                name: 'web_search_exa',
                description: 'Search the web',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                    },
                    required: ['query'],
                },
                serverId: 'server-123',
            }),
        };

        const result = await executeMetaTool(
            'mcp_get_tool_schema',
            { toolName: 'web_search_exa', serverId: 'server-123' },
            router as any
        );

        expect(result?.isError).toBe(false);
        const text = (result?.content[0] as any).text;
        const schema = JSON.parse(text);
        expect(schema.executionInstructions).toEqual(
            expect.objectContaining({
                nextTool: 'mcp_execute_tool',
                toolName: 'web_search_exa',
                serverId: 'server-123',
            })
        );
        expect(schema.executionInstructions.note).toContain('Do not call this discovered tool directly');
    });

    test('should list every tool from a matching server without search-result truncation', async () => {
        const supabaseTools = Array.from({ length: 29 }, (_, index) => ({
            name: `supabase_tool_${index + 1}`,
            description: `Supabase database capability ${index + 1}`,
        }));
        const router = new ToolRouter([
            createRouterClient('supabase-server', 'Supabase MCP', supabaseTools) as any,
        ], { strategy: 'search' });

        const result = await executeMetaTool(
            'mcp_search_tools',
            { query: 'supabase', operation: 'list', serverName: 'supabase', limit: 100 },
            router
        );

        expect(result?.isError).toBe(false);
        const text = (result?.content[0] as any).text;
        expect(text).toContain('totalCount: 29');
        expect(text).toContain('returnedCount: 29');
        expect(text).toContain('supabase_tool_1');
        expect(text).toContain('supabase_tool_29');
    });

    test('should search within a server when serverName is provided', async () => {
        const router = new ToolRouter([
            createRouterClient('supabase-server', 'Supabase MCP', [
                { name: 'search_projects', description: 'Search Supabase projects' },
            ]) as any,
            createRouterClient('web-server', 'Web Search', [
                { name: 'web_search', description: 'Search the web' },
            ]) as any,
        ], { strategy: 'search' });

        const result = await executeMetaTool(
            'mcp_search_tools',
            { query: 'search', serverName: 'supabase', limit: 10 },
            router
        );

        expect(result?.isError).toBe(false);
        const text = (result?.content[0] as any).text;
        expect(text).toContain('search_projects');
        expect(text).not.toContain('web_search');
    });

    test('should not infer unrelated tools for temporal fuzzy questions without direct lexical match', async () => {
        const router = new ToolRouter([
            createRouterClient('web-server', 'Web Search', [
                {
                    name: 'web_search',
                    description: 'Search the web for current information and recent results',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query' },
                        },
                    },
                },
            ]) as any,
        ], { strategy: 'search' });

        const result = await executeMetaTool(
            'mcp_search_tools',
            { query: "who won yesterday's ipl match", limit: 5 },
            router
        );

        expect(result?.isError).toBe(false);
        const text = (result?.content[0] as any).text;
        expect(text).toContain('Call mcp_list_servers');
    });

    test('should list connected servers for server-aware recovery', async () => {
        const router = new ToolRouter([
            createRouterClient('web-server', 'Web Search', [
                { name: 'web_search', description: 'Search the web' },
            ]) as any,
            createRouterClient('supabase-server', 'Supabase MCP', [
                { name: 'list_tables', description: 'List tables' },
            ]) as any,
        ], { strategy: 'search' });

        const result = await executeMetaTool(
            'mcp_list_servers',
            {},
            router
        );

        expect(result?.isError).toBe(false);
        const text = (result?.content[0] as any).text;
        expect(text).toContain('Web Search');
        expect(text).toContain('Supabase MCP');
        expect(text).toContain('Tool count: 1');
    });

    test('should execute the search tools meta-tool name', async () => {
        const router = new ToolRouter([
            createRouterClient('web-server', 'Web Search', [
                { name: 'web_search', description: 'Search the web' },
            ]) as any,
        ], { strategy: 'search' });

        const result = await executeMetaTool(
            'mcp_search_tools',
            { query: 'web', limit: 5 },
            router
        );

        expect(result?.isError).toBe(false);
        expect((result?.content[0] as any).text).toContain('web_search');
    });
});
