import { test, expect } from '@playwright/test';
import { AIAdapter } from '../../src/adapters/ai-adapter';
import { MCPClient } from '../../src/server/mcp/oauth-client';
import { ToolRouter } from '../../src/shared/tool-router';
import { ElicitationInterruptError } from '../../src/shared/errors';

class MockMCPClient {
    private connected = true;
    private serverId = 'test-server';
    private sessionId = 'test-session';

    isConnected() {
        return this.connected;
    }

    getServerId() {
        return this.serverId;
    }

    getSessionId() {
        return this.sessionId;
    }

    async listTools() {
        return {
            tools: [
                {
                    name: 'test_tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object' as const,
                        properties: {
                            message: { type: 'string' as const }
                        },
                        required: ['message']
                    }
                }
            ]
        };
    }

    async callTool(name: string, args: Record<string, unknown>) {
        return {
            content: [{ type: 'text' as const, text: `Called ${name} with ${JSON.stringify(args)}` }]
        };
    }
}

test.describe('AIAdapter', () => {
    test('should transform tools correctly', async () => {
        const mockClient = new MockMCPClient() as unknown as MCPClient;
        const adapter = new AIAdapter(mockClient);

        const tools = await adapter.getTools();

        expect(Object.keys(tools)).toHaveLength(1);
        expect(Object.keys(tools)[0]).toContain('tool_testserv_test_tool');
    });

    test('should use custom prefix', async () => {
        const mockClient = new MockMCPClient() as unknown as MCPClient;
        const adapter = new AIAdapter(mockClient, { prefix: 'custom' });

        const tools = await adapter.getTools();

        expect(Object.keys(tools)[0]).toContain('tool_custom_test_tool');
    });

    test('should handle disconnected client', async () => {
        const mockClient = new MockMCPClient() as unknown as MCPClient;
        (mockClient as any).connected = false;

        const adapter = new AIAdapter(mockClient);
        const tools = await adapter.getTools();

        expect(Object.keys(tools)).toHaveLength(0);
    });

    test('static getTools should work', async () => {
        const mockClient = new MockMCPClient() as unknown as MCPClient;
        const tools = await AIAdapter.getTools(mockClient);

        expect(Object.keys(tools)).toHaveLength(1);
    });

    test('should namespace router-backed duplicate tool names per server', async () => {
        const createRouterClient = (serverId: string, serverName: string, sessionId: string) => ({
            isConnected: () => true,
            getServerId: () => serverId,
            getServerName: () => serverName,
            getSessionId: () => sessionId,
            listTools: async () => ({
                tools: [
                    {
                        name: 'duplicate_tool',
                        description: `Tool from ${serverName}`,
                        inputSchema: {
                            type: 'object' as const,
                            properties: {
                                message: { type: 'string' as const }
                            }
                        }
                    }
                ]
            }),
            callTool: async (name: string, args: Record<string, unknown>) => ({
                content: [{ type: 'text' as const, text: `${serverName}:${name}:${JSON.stringify(args)}` }]
            })
        });

        const alphaClient = createRouterClient('alpha-server', 'Alpha Server', 'alpha-session');
        const betaClient = createRouterClient('beta-server', 'Beta Server', 'beta-session');
        const router = new ToolRouter([alphaClient as any, betaClient as any], { strategy: 'all' });
        const adapter = new AIAdapter({ getClients: () => [alphaClient as any, betaClient as any] } as any, { toolRouter: router });

        const tools = await adapter.getTools();
        const keys = Object.keys(tools);

        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);

        const results = await Promise.all(
            keys.map((key) => (tools[key] as any).execute({ message: key }))
        );

        const texts = results.map((result: any) => result.content[0].text);
        expect(texts).toContain('Alpha Server:duplicate_tool:{"message":"tool_alpha_session_duplicate_tool"}');
        expect(texts).toContain('Beta Server:duplicate_tool:{"message":"tool_beta_session_duplicate_tool"}');
    });

    test('should surface elicitation interrupts from search-mode execute tool as structured output', async () => {
        const params = {
            mode: 'form' as const,
            message: 'Configure your monitoring alert settings.',
            requestedSchema: {
                type: 'object',
                properties: {
                    channel: { type: 'string' },
                },
            },
        };
        const client = {
            isConnected: () => true,
            getServerId: () => 'alert-server',
            getServerName: () => 'Alert Server',
            getSessionId: () => 'alert-session',
            listTools: async () => ({
                tools: [
                    {
                        name: 'configure_alert',
                        description: 'Configure a monitoring alert',
                        inputSchema: { type: 'object' as const, properties: {} },
                    },
                ],
            }),
            callTool: async () => {
                throw new ElicitationInterruptError(params);
            },
        };
        const router = new ToolRouter(client as any, { strategy: 'search' });
        const adapter = new AIAdapter(client as any, { toolRouter: router });

        const tools = await adapter.getTools();
        const result = await (tools.mcp_execute_tool as any).execute({
            toolName: 'configure_alert',
            args: {},
        });
        const payload = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(payload._mcp_elicitation).toBe(true);
        expect(payload.message).toBe(params.message);
        expect(payload.requestedSchema).toEqual(params.requestedSchema);
    });

    test('should surface foreign bundled elicitation interrupts as structured output', async () => {
        const params = {
            mode: 'form' as const,
            message: 'Configure your monitoring alert settings.',
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
        const client = {
            isConnected: () => true,
            getServerId: () => 'alert-server',
            getServerName: () => 'Alert Server',
            getSessionId: () => 'alert-session',
            listTools: async () => ({
                tools: [
                    {
                        name: 'configure_alert',
                        description: 'Configure a monitoring alert',
                        inputSchema: { type: 'object' as const, properties: {} },
                    },
                ],
            }),
            callTool: async () => {
                throw interrupt;
            },
        };
        const router = new ToolRouter(client as any, { strategy: 'search' });
        const adapter = new AIAdapter(client as any, { toolRouter: router });

        const tools = await adapter.getTools();
        const result = await (tools.mcp_execute_tool as any).execute({
            toolName: 'configure_alert',
            args: {},
        });
        const payload = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(payload._mcp_elicitation).toBe(true);
        expect(payload.message).toBe(params.message);
        expect(payload.requestedSchema).toEqual(params.requestedSchema);
    });
});
