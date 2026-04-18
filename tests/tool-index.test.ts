import { test, expect } from '@playwright/test';
import { ToolIndex, type IndexedTool } from '../src/shared/tool-index';

test.describe('ToolIndex', () => {
    test('should keep duplicate tool names searchable per indexed instance', async () => {
        const index = new ToolIndex();
        const tools: IndexedTool[] = [
            {
                name: 'search',
                description: 'Search GitHub pull requests and repositories',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'GitHub',
                sessionId: 'github-session',
            },
            {
                name: 'search',
                description: 'Search Slack messages and channels',
                inputSchema: { type: 'object', properties: {} },
                serverName: 'Slack',
                sessionId: 'slack-session',
            },
        ];

        await index.buildIndex(tools);

        const githubResults = await index.search('github pull requests', 2);
        const slackResults = await index.search('slack channels', 2);

        expect(githubResults[0].serverName).toBe('GitHub');
        expect(slackResults[0].serverName).toBe('Slack');
        expect(index.getTool('search')).toHaveLength(2);
        expect(githubResults[0].estimatedTokens).toBeGreaterThan(0);
        expect(index.getTotalTokenCost()).toBe(
            githubResults[0].estimatedTokens + slackResults[0].estimatedTokens
        );
    });
});
