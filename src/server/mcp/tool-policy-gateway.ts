import type { Tool, ListToolsResult, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolClient } from '../../shared/types.js';
import { sessions } from '../storage/index.js';
import type { Session } from '../storage/types.js';
import { assertToolAllowed, filterToolsByPolicy } from '../storage/tool-policy.js';

type RawToolClient = ToolClient & {
    listTools(options?: { emitDiscoveryEvent?: boolean }): Promise<{ tools: Tool[] }>;
    callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
};

export class ToolPolicyGateway implements ToolClient {
    constructor(
        private readonly userId: string,
        private readonly sessionId: string,
        private readonly client: RawToolClient
    ) {}

    isConnected(): boolean {
        return this.client.isConnected();
    }

    getServerId(): string | undefined {
        return this.client.getServerId?.();
    }

    getServerName(): string | undefined {
        return this.client.getServerName?.();
    }

    getSessionId(): string {
        return this.client.getSessionId?.() ?? this.sessionId;
    }

    async listTools(): Promise<ListToolsResult> {
        const session = await this.getSession();
        const result = await this.client.listTools({ emitDiscoveryEvent: false });
        const tools = this.filterTools(session, result.tools);

        return {
            ...result,
            tools,
        } as ListToolsResult;
    }

    async listAllTools(): Promise<ListToolsResult> {
        return await this.client.listTools({ emitDiscoveryEvent: false }) as ListToolsResult;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        const session = await this.getSession();
        this.assertAllowed(session, name);
        return await this.client.callTool(name, args);
    }

    filterTools(session: Session, tools: Tool[]): Tool[] {
        return filterToolsByPolicy(tools, session.toolPolicy, this.getPolicyServerId(session));
    }

    assertAllowed(session: Session, toolName: string): void {
        assertToolAllowed(session.toolPolicy, toolName, this.getPolicyServerId(session));
    }

    private async getSession(): Promise<Session> {
        const session = await sessions.get(this.userId, this.sessionId);
        if (!session) {
            throw new Error('Session not found');
        }
        return session;
    }

    private getPolicyServerId(session: Session): string | undefined {
        return this.client.getServerId?.() ?? session.serverId;
    }
}

export function createToolPolicyGateway(
    userId: string,
    sessionId: string,
    client: RawToolClient
): ToolPolicyGateway {
    return new ToolPolicyGateway(userId, sessionId, client);
}

