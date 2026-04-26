import { MCPClient } from '../server/mcp/oauth-client';
import { MultiSessionClient } from '../server/mcp/multi-session-client';
import type { JSONSchema7 } from 'json-schema';
import type { StopCondition, ToolSet } from 'ai';
import { ToolRouter } from '../shared/tool-router.js';
import { executeMetaTool, isMetaTool } from '../shared/meta-tools.js';
import { isElicitationInterruptError } from '../shared/errors.js';
import { getElicitationBroker, type ElicitationBrokerRequest } from '../server/mcp/elicitation-broker.js';

type ElicitationToolOutput = {
    isError?: boolean;
    content?: Array<{
        type?: unknown;
        text?: unknown;
    }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isMcpElicitationPayload(value: unknown): boolean {
    return isRecord(value) && value._mcp_elicitation === true;
}

function isMcpElicitationToolOutput(output: unknown): boolean {
    if (isMcpElicitationPayload(output)) {
        return true;
    }

    if (typeof output === 'string') {
        return isMcpElicitationPayload(parseJsonObject(output));
    }

    if (!isRecord(output)) {
        return false;
    }

    const toolOutput = output as ElicitationToolOutput;
    if (!Array.isArray(toolOutput.content)) {
        return false;
    }

    return toolOutput.content.some((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') {
            return false;
        }
        return isMcpElicitationPayload(parseJsonObject(part.text));
    });
}

/**
 * AI SDK stop condition that pauses the tool loop when an MCP server requests
 * elicitation. Without this, the model receives the elicitation payload as a
 * normal tool result and may continue by narrating that a form is needed.
 */
export function hasMcpElicitation(): StopCondition<any> {
    return ({ steps }) => {
        const lastStep = steps[steps.length - 1];
        if (!lastStep) {
            return false;
        }

        const resultOutputs = [
            ...(lastStep.toolResults ?? []).map((result) => result.output),
            ...(lastStep.content ?? [])
                .filter((part) => part.type === 'tool-result' || part.type === 'tool-error')
                .map((part) => (part as { output?: unknown }).output),
        ];

        return resultOutputs.some(isMcpElicitationToolOutput);
    };
}

export interface AIAdapterOptions {
    /** 
     * Prefix for tool names to avoid collision with other tools.
     * Defaults to the client's serverId.
     */
    prefix?: string;

    /**
     * Optional ToolRouter for intelligent tool selection.
     *
     * When provided with `strategy: 'search'`, the adapter exposes only
     * meta-tools (search_tools, get_tool_schema) instead of all tool schemas,
     * reducing context window usage by 80–95%.
     *
     * When not provided, all tools are returned as before (backward-compatible).
     */
    toolRouter?: ToolRouter;

    /**
     * Controls how MCP elicitation requests are surfaced to AI SDK callers.
     *
     * - `interrupt` keeps the historical behavior: elicitation is returned as a
     *   final structured tool output and the tool loop can stop on it.
     * - `preliminary` yields the elicitation request as a preliminary tool
     *   output while the original MCP tool call remains pending until the user
     *   responds via `elicitationRespond`.
     */
    elicitation?: {
        mode: 'interrupt' | 'preliminary';
        identity?: string;
        sessionId?: string;
        serverId?: string;
    };
}

/**
 * Adapter to use MCP tools with the Vercel AI SDK.
 */
export class AIAdapter {
    private jsonSchema: typeof import('ai').jsonSchema | undefined;

    constructor(
        private client: MCPClient | MultiSessionClient,
        private options: AIAdapterOptions = {}
    ) { }



    /**
     * Lazy-loads the jsonSchema function from the AI SDK.
     */
    private async ensureJsonSchema() {
        if (!this.jsonSchema) {
            const { jsonSchema } = await import('ai');
            this.jsonSchema = jsonSchema;
        }
    }

    private shouldPreviewElicitation(request: ElicitationBrokerRequest): boolean {
        const config = this.options.elicitation;
        if (config?.mode !== 'preliminary') {
            return false;
        }

        if (config.identity && request.identity !== config.identity) {
            return false;
        }
        if (config.sessionId && request.sessionId !== config.sessionId) {
            return false;
        }
        if (config.serverId && request.serverId !== config.serverId) {
            return false;
        }

        return true;
    }

    private createElicitationOutput(request: ElicitationBrokerRequest) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    _mcp_elicitation: true,
                    elicitationId: request.elicitationId,
                    mode: request.mode,
                    message: request.message,
                    requestedSchema: request.requestedSchema,
                    url: request.url,
                    sessionId: request.sessionId,
                    serverId: request.serverId,
                })
            }],
            isError: false
        };
    }

    private executeWithElicitationPreviews<T>(executeCall: () => Promise<T>): AsyncGenerator<T | ReturnType<AIAdapter['createElicitationOutput']>> {
        const self = this;

        return (async function* () {
            const broker = getElicitationBroker();
            const queue: ElicitationBrokerRequest[] = [];
            const waiters: Array<() => void> = [];
            let settled = false;

            const notify = () => {
                while (waiters.length > 0) {
                    waiters.shift()?.();
                }
            };

            const unsubscribe = broker.subscribe((request) => {
                if (!self.shouldPreviewElicitation(request)) {
                    return;
                }

                queue.push(request);
                notify();
            });

            const resultPromise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> = executeCall()
                .then((value) => {
                    settled = true;
                    notify();
                    return { ok: true as const, value };
                })
                .catch((error) => {
                    settled = true;
                    notify();
                    return { ok: false as const, error };
                });

            try {
                while (true) {
                    while (queue.length > 0) {
                        yield self.createElicitationOutput(queue.shift()!);
                    }

                    if (settled) {
                        const result = await resultPromise;
                        if (result.ok === false) {
                            throw result.error;
                        }
                        yield result.value;
                        return;
                    }

                    await new Promise<void>((resolve) => {
                        waiters.push(resolve);
                    });
                }
            } finally {
                unsubscribe();
            }
        })();
    }

    private executeMaybeWithElicitationPreviews<T>(executeCall: () => Promise<T>): Promise<T> | AsyncGenerator<T | ReturnType<AIAdapter['createElicitationOutput']>> {
        if (this.options.elicitation?.mode === 'preliminary') {
            return this.executeWithElicitationPreviews(executeCall);
        }

        return executeCall();
    }

    private async transformTools(client: MCPClient): Promise<ToolSet> {
        // Safe check for isConnected method (duck typing for bundler compatibility)
        const isConnected = typeof client.isConnected === 'function'
            ? client.isConnected()
            : false;

        if (!isConnected) {
            return {};
        }

        const result = await client.listTools();

        // @ts-ignore: ToolSet type inference can be tricky with dynamic imports
        return Object.fromEntries(
            result.tools.map((tool) => {
                // Safe access to getServerId
                const serverId = typeof client.getServerId === 'function'
                    ? client.getServerId()
                    : undefined;
                const prefix = this.options.prefix ?? serverId?.replace(/-/g, '').substring(0, 8) ?? 'mcp';
                return [
                    `tool_${prefix}_${tool.name}`,
                    {
                        description: tool.description,
                        inputSchema: this.jsonSchema!(tool.inputSchema as JSONSchema7),
                        execute: (args: any) => this.executeMaybeWithElicitationPreviews(async () => {
                            try {
                                console.log('[MCP-ElicitDebug][ai-adapter] executing direct tool', {
                                    toolName: tool.name,
                                });
                                const response = await client.callTool(tool.name, args);
                                console.log('[MCP-ElicitDebug][ai-adapter] direct tool resolved', {
                                    toolName: tool.name,
                                });
                                return response;
                            } catch (error) {
                                console.log('[MCP-ElicitDebug][ai-adapter] direct tool threw', {
                                    toolName: tool.name,
                                    name: error instanceof Error ? error.name : typeof error,
                                    message: error instanceof Error ? error.message : String(error),
                                    isElicitationInterrupt: isElicitationInterruptError(error),
                                    hasParams: !!(error as { params?: unknown } | null | undefined)?.params,
                                });
                                if (isElicitationInterruptError(error)) {
                                    console.log('[MCP-ElicitDebug][ai-adapter] returning structured elicitation output', {
                                        toolName: tool.name,
                                    });
                                    return {
                                        content: [{
                                            type: 'text',
                                            text: JSON.stringify({
                                                _mcp_elicitation: true,
                                                ...error.params
                                            })
                                        }],
                                        isError: true
                                    };
                                }
                                const errorMessage = error instanceof Error ? error.message : String(error);
                                throw new Error(`Tool execution failed: ${errorMessage}`);
                            }
                        })
                    }
                ];
            })
        );
    }

    /**
     * Fetches tools from the client(s) and converts them to AI SDK tools.
     */
    async getTools(): Promise<ToolSet> {
        await this.ensureJsonSchema();

        // If a ToolRouter is provided, use its filtered output
        if (this.options.toolRouter) {
            return this.getToolsViaRouter(this.options.toolRouter);
        }

        // Use duck typing instead of instanceof to handle module bundling issues
        // MultiSessionClient has getClients(), MCPClient does not
        const isMultiSession = typeof (this.client as any).getClients === 'function';
        const clients = isMultiSession
            ? (this.client as MultiSessionClient).getClients()
            : [this.client as MCPClient];

        const results = await Promise.all(
            clients.map(async (client) => {
                try {
                    return await this.transformTools(client);
                } catch (error) {
                    // For multi-client, we log and continue.
                    // This is safer than throwing.
                    const serverId = typeof client.getServerId === 'function'
                        ? client.getServerId() ?? 'unknown'
                        : 'unknown';
                    console.error(`[AIAdapter] Failed to fetch tools from ${serverId}:`, error);
                    return {};
                }
            })
        );

        return results.reduce((acc, tools) => ({ ...acc, ...tools }), {});
    }

    /**
     * Build a ToolSet from a ToolRouter's filtered output.
     *
     * In `search` strategy, only meta-tools are registered with the framework.
     * Real tool execution is proxied through `mcp_execute_tool` which uses
     * `router.callTool()` to route to the correct MCP client.
     */
    private async getToolsViaRouter(router: ToolRouter): Promise<ToolSet> {
        const filteredTools = await router.getFilteredTools();

        // @ts-ignore: ToolSet type inference can be tricky with dynamic imports
        return Object.fromEntries(
            filteredTools.map((tool) => {
                const routedTool = tool as typeof tool & { sessionId?: string; serverId?: string; serverName?: string };
                const namespace = routedTool.serverId ?? routedTool.sessionId;
                const toolKey = isMetaTool(tool.name)
                    ? tool.name
                    : this.getRouterToolKey(tool.name, routedTool.sessionId, routedTool.serverId);

                return [
                    toolKey,
                    {
                        description: tool.description,
                        inputSchema: this.jsonSchema!(tool.inputSchema as JSONSchema7),
                        execute: (args: any) => this.executeMaybeWithElicitationPreviews(async () => {
                            try {
                                // Handle meta-tool calls via the router
                                if (isMetaTool(tool.name)) {
                                    console.log('[MCP-ElicitDebug][ai-adapter] executing meta-tool', {
                                        toolName: tool.name,
                                        args,
                                    });
                                    const result = await executeMetaTool(
                                        tool.name,
                                        args,
                                        router,
                                        (name, toolArgs, targetNamespace) => router.callTool(name, toolArgs, targetNamespace)
                                    );
                                    if (result) {
                                      console.log('[MCP-ElicitDebug][ai-adapter] meta-tool resolved', {
                                        toolName: tool.name,
                                        isError: result.isError,
                                        firstText: result.content?.[0]?.type === 'text'
                                            ? result.content[0].text?.slice(0, 120)
                                            : undefined,
                                      });
                                      return result;
                                    }
                                }

                                // For non-meta tools in 'all' or 'groups' strategy,
                                // route directly to the correct MCP client
                                console.log('[MCP-ElicitDebug][ai-adapter] executing routed tool', {
                                    toolName: tool.name,
                                    namespace,
                                });
                                return await router.callTool(tool.name, args, namespace);
                            } catch (error) {
                                console.log('[MCP-ElicitDebug][ai-adapter] tool threw', {
                                    toolName: tool.name,
                                    name: error instanceof Error ? error.name : typeof error,
                                    message: error instanceof Error ? error.message : String(error),
                                    isElicitationInterrupt: isElicitationInterruptError(error),
                                    hasParams: !!(error as { params?: unknown } | null | undefined)?.params,
                                });
                                if (isElicitationInterruptError(error)) {
                                    console.log('[MCP-ElicitDebug][ai-adapter] returning structured elicitation output', {
                                        toolName: tool.name,
                                    });
                                    return {
                                        content: [{
                                            type: 'text',
                                            text: JSON.stringify({
                                                _mcp_elicitation: true,
                                                ...error.params
                                            })
                                        }],
                                        isError: true
                                    };
                                }
                                throw error;
                            }
                        }),
                    },
                ];
            })
        );
    }

    private getRouterToolKey(toolName: string, sessionId?: string, serverId?: string): string {
        const namespace = sessionId ?? serverId ?? 'mcp';
        const normalized = namespace
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'mcp';
        return `tool_${normalized}_${toolName}`;
    }

    /**
     * Convenience static method to fetch tools in a single line.
     */
    static async getTools(client: MCPClient | MultiSessionClient, options: AIAdapterOptions = {}): Promise<ToolSet> {
        return new AIAdapter(client, options).getTools();
    }
}
