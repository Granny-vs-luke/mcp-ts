import { test, expect } from '@playwright/test';
import { ToolIndex, type IndexedTool } from '../src/shared/tool-index';

test.describe('ToolIndex', () => {
    test('should return all exact name matches up to topK across servers', async () => {
        const index = new ToolIndex();
        const tools: IndexedTool[] = [
            {
                name: 'search',
                description: 'Search GitHub pull requests and repositories',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'GitHub',
                sessionId: 'github-session',
                serverId: 'github-server',
            },
            {
                name: 'search',
                description: 'Search Slack messages and channels',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'Slack',
                sessionId: 'slack-session',
                serverId: 'slack-server',
            },
        ];

        await index.buildIndex(tools);

        const exactResults = await index.search('search', 2);

        expect(exactResults).toHaveLength(2);
        expect(exactResults.map((r) => r.serverName).sort()).toEqual(['GitHub', 'Slack']);
    });

    test('should keep duplicate tool names searchable per indexed instance', async () => {
        const index = new ToolIndex();
        const tools: IndexedTool[] = [
            {
                name: 'search',
                description: 'Search GitHub pull requests and repositories',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'GitHub',
                sessionId: 'github-session',
                serverId: 'github-server',
            },
            {
                name: 'search',
                description: 'Search Slack messages and channels',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'Slack',
                sessionId: 'slack-session',
                serverId: 'slack-server',
            },
        ];

        await index.buildIndex(tools);

        const githubResults = await index.search('github pull requests', 2);
        const slackResults = await index.search('slack channels', 2);

        expect(githubResults[0].serverName).toBe('GitHub');
        expect(githubResults[0].serverId).toBe('github-server');
        expect(slackResults[0].serverName).toBe('Slack');
        expect(slackResults[0].serverId).toBe('slack-server');
        expect(index.getTool('search')).toHaveLength(2);
        expect(githubResults[0].estimatedTokens).toBeGreaterThan(0);
        expect(index.getTotalTokenCost()).toBe(
            githubResults[0].estimatedTokens + slackResults[0].estimatedTokens
        );
    });

    test('should prefer exact namespace matches before fuzzy server names', async () => {
        const index = new ToolIndex();
        const tools: IndexedTool[] = [
            {
                name: 'search',
                description: 'Search GitHub pull requests and repositories',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'GitHub',
                sessionId: 'github-session',
                serverId: 'github',
            },
            {
                name: 'search',
                description: 'Search enterprise GitHub resources',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'GitHub Enterprise',
                sessionId: 'enterprise-session',
                serverId: 'enterprise',
            },
        ];

        await index.buildIndex(tools);

        const results = index.getTool('search', 'github');

        expect(results).toHaveLength(1);
        expect(results[0].serverId).toBe('github');
    });

    test('should strip required-term prefixes before embedding query text', async () => {
        let embeddingQueryText: string | null = null;
        const embedFn = async (texts: string[]): Promise<number[][]> => {
            if (texts.length === 1) {
                embeddingQueryText = texts[0];
            }
            return texts.map((text) => [text.length, 1]);
        };

        const index = new ToolIndex({ embedFn });
        const tools: IndexedTool[] = [
            {
                name: 'send_message',
                description: 'Send Slack messages',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'Slack',
                sessionId: 'slack-session',
                serverId: 'slack-server',
            },
            {
                name: 'create_pr',
                description: 'Create GitHub pull requests',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'GitHub',
                sessionId: 'github-session',
                serverId: 'github-server',
            },
        ];

        await index.buildIndex(tools);
        const results = await index.search('+slack send', 5);

        expect(embeddingQueryText).toBe('slack send');
        expect(results[0].serverId).toBe('slack-server');
    });
});
