/**
 * Meta-tools — Injectable tool definitions that let the LLM discover and
 * load MCP tools on-demand, following Anthropic's Tool Search pattern.
 *
 * Instead of injecting 50+ full tool schemas into the context window, you
 * inject just these 2 meta-tools (~800 tokens). The LLM calls them to
 * find and load only the tools it actually needs.
 *
 * @packageDocumentation
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRouter } from './tool-router.js';

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

/**
 * Creates the `mcp_search_tools` tool definition.
 *
 * This tool lets the LLM search the full catalog of available MCP tools
 * using a natural-language query. Returns tool names and descriptions
 * without the full inputSchema to save context space.
 */
export function createSearchToolDefinition(): Tool {
  return {
    name: 'mcp_search_tools',
    description:
      'Search the catalog of available tools by describing what you need. ' +
      'Returns tool names, descriptions, and server info. ' +
      'Use this FIRST to find relevant tools before calling them. ' +
      'Example queries: "database query", "send email", "github pull request".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of the capability you need.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5, max: 20).',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * Creates the `mcp_get_tool_schema` tool definition.
 *
 * After discovering tools via `mcp_search_tools`, the LLM calls this
 * to load the full inputSchema for a specific tool so it can construct
 * the correct arguments.
 */
export function createGetSchemaToolDefinition(): Tool {
  return {
    name: 'mcp_get_tool_schema',
    description:
      'Get the full input schema (parameters) for a specific tool. ' +
      'Call this after mcp_search_tools to get the parameter details ' +
      'needed to call a tool correctly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        toolName: {
          type: 'string',
          description: 'The exact tool name returned by mcp_search_tools.',
        },
      },
      required: ['toolName'],
    },
  };
}

/**
 * Creates the `mcp_list_tool_groups` tool definition.
 *
 * Lets the LLM see what tool categories/servers are available and
 * how many tools each has.
 */
export function createListGroupsToolDefinition(): Tool {
  return {
    name: 'mcp_list_tool_groups',
    description:
      'List all available tool groups/categories with tool counts. ' +
      'Groups are organized by MCP server. Use this to understand ' +
      'what capabilities are available before searching.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Meta-tool Executors
// ---------------------------------------------------------------------------

/**
 * Execute a meta-tool call and return the result in MCP CallToolResult format.
 *
 * @param toolName - One of the meta-tool names (mcp_search_tools, etc.)
 * @param args - The arguments from the LLM's tool call
 * @param router - The ToolRouter to query
 * @returns MCP-compatible CallToolResult, or null if this isn't a meta-tool
 */
export async function executeMetaTool(
  toolName: string,
  args: Record<string, unknown>,
  router: ToolRouter
): Promise<CallToolResult | null> {
  switch (toolName) {
    case 'mcp_search_tools': {
      const query = String(args.query ?? '');
      const limit = Math.min(Number(args.limit) || 5, 20);

      const results = await router.searchTools(query, limit);

      const text = results.length === 0
        ? 'No tools found matching your query. Try different keywords.'
        : results
            .map(
              (t, i) =>
                `${i + 1}. **${t.name}** (server: ${t.serverName})\n` +
                `   ${t.description}\n` +
                `   Estimated tokens: ${t.estimatedTokens}`
            )
            .join('\n');

      return {
        content: [{ type: 'text', text }],
        isError: false,
      };
    }

    case 'mcp_get_tool_schema': {
      const name = String(args.toolName ?? '');
      const tool = router.getToolSchema(name);

      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: `Tool "${name}" not found. Use mcp_search_tools to find available tools first.`,
            },
          ],
          isError: true,
        };
      }

      const schema = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
        isError: false,
      };
    }

    case 'mcp_list_tool_groups': {
      const groups = router.getGroups();

      if (groups.size === 0) {
        return {
          content: [{ type: 'text', text: 'No tool groups available. No MCP servers are connected.' }],
          isError: false,
        };
      }

      const lines: string[] = ['Available tool groups:\n'];
      for (const [groupName, info] of groups) {
        const status = info.active ? '✓ active' : '○ inactive';
        lines.push(`• **${groupName}** — ${info.tools.length} tools [${status}]`);
        // Show first 3 tool names as preview
        const preview = info.tools.slice(0, 3).join(', ');
        const more = info.tools.length > 3 ? `, +${info.tools.length - 3} more` : '';
        lines.push(`  Tools: ${preview}${more}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
      };
    }

    default:
      return null;
  }
}

/** Check if a tool name is one of the meta-tools. */
export function isMetaTool(toolName: string): boolean {
  return (
    toolName === 'mcp_search_tools' ||
    toolName === 'mcp_get_tool_schema' ||
    toolName === 'mcp_list_tool_groups'
  );
}
