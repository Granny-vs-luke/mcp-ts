import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolPolicy } from './types.js';

export type ToolPolicyInput = {
    mode?: unknown;
    toolIds?: unknown;
    updatedAt?: unknown;
} | null | undefined;

export function createToolId(serverId: string, toolName: string): string {
    return `${serverId}::${toolName}`;
}

function normalizeToolIds(input?: unknown): string[] {
    if (!Array.isArray(input)) return [];

    return Array.from(new Set(
        input
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim())
            .filter(Boolean)
    ));
}

export function normalizeToolPolicy(input?: ToolPolicyInput, now = Date.now()): ToolPolicy | undefined {
    if (!input || typeof input !== 'object') {
        return undefined;
    }

    const mode = input.mode === 'allowlist' || input.mode === 'denylist'
        ? input.mode
        : 'all';
    const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : now;

    if (mode === 'all') {
        return { mode: 'all', toolIds: [], updatedAt };
    }

    return { mode, toolIds: normalizeToolIds(input.toolIds), updatedAt };
}

export function normalizeToolPolicyForUpdate(input: ToolPolicyInput, now = Date.now()): ToolPolicy {
    return normalizeToolPolicy(input, now) ?? { mode: 'all', toolIds: [], updatedAt: now };
}

export function isToolAllowed(policy: ToolPolicy | undefined, toolName: string, serverId?: string): boolean {
    if (!policy || policy.mode === 'all') return true;
    if (!serverId) return false;

    const toolId = createToolId(serverId, toolName);
    if (policy.mode === 'allowlist') {
        return policy.toolIds.includes(toolId);
    }

    return !policy.toolIds.includes(toolId);
}

export function assertToolAllowed(policy: ToolPolicy | undefined, toolName: string, serverId?: string): void {
    if (isToolAllowed(policy, toolName, serverId)) return;
    throw new Error(`Tool "${toolName}" is not allowed for this MCP session`);
}

export function filterToolsByPolicy<T extends Pick<Tool, 'name'>>(
    tools: T[],
    policy: ToolPolicy | undefined,
    serverId?: string
): T[] {
    if (!policy || policy.mode === 'all') return tools;
    return tools.filter((tool) => isToolAllowed(policy, tool.name, serverId));
}

export function validateToolPolicyAgainstTools(
    policy: ToolPolicy,
    tools: Array<Pick<Tool, 'name'>>,
    serverId?: string
): void {
    if (policy.mode === 'all') return;
    if (!serverId) {
        throw new Error('Cannot validate MCP tool policy without a serverId');
    }

    const availableIds = new Set(tools.map((tool) => createToolId(serverId, tool.name)));
    const unknownIds = policy.toolIds.filter((id) => !availableIds.has(id));
    if (unknownIds.length > 0) {
        throw new Error(`Unknown tool id(s) for this MCP session: ${unknownIds.join(', ')}`);
    }
}
