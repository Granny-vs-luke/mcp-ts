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
 * Creates the `mcp_execute_tool` tool definition.
 *
 * This is the execution meta-tool — the LLM calls this to execute any
 * tool discovered via `mcp_search_tools`. The LLM should first call
 * `mcp_get_tool_schema` to know the correct arguments.
 *
 * Inspired by Composio's `COMPOSIO_MULTI_EXECUTE_TOOL` pattern:
 * instead of registering every real tool with the framework, we proxy
 * all execution through a single meta-tool.
 */
export function createExecuteToolDefinition(): Tool {
  return {
    name: 'mcp_execute_tool',
    description:
      'Execute a tool that was discovered via mcp_search_tools. ' +
      'You MUST call mcp_get_tool_schema first to know the correct parameters. ' +
      'Pass the exact tool name and its arguments.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        toolName: {
          type: 'string',
          description: 'The exact tool name from mcp_search_tools results.',
        },
        args: {
          type: 'object',
          description: "Arguments matching the tool's inputSchema. Omit or pass {} if the tool takes no parameters.",
          additionalProperties: true,
        },
      },
      required: ['toolName'],
    },
  };
}

// ---------------------------------------------------------------------------
// Meta-tool Executors
// ---------------------------------------------------------------------------

/**
 * Callback for executing a real MCP tool via the correct client.
 * Provided by adapters that wire up client routing.
 */
export type CallToolFn = (toolName: string, args: Record<string, unknown>) => Promise<any>;

/**
 * Execute a meta-tool call and return the result in MCP CallToolResult format.
 *
 * @param toolName - One of the meta-tool names (mcp_search_tools, etc.)
 * @param args - The arguments from the LLM's tool call
 * @param router - The ToolRouter to query
 * @param callToolFn - Optional callback for executing real tools (required for mcp_execute_tool)
 * @returns MCP-compatible CallToolResult, or null if this isn't a meta-tool
 */
export async function executeMetaTool(
  toolName: string,
  args: Record<string, unknown>,
  router: ToolRouter,
  callToolFn?: CallToolFn
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

    case 'mcp_execute_tool': {
      const targetToolName = String(args.toolName ?? '');
      const toolArgs = (args.args as Record<string, unknown>) ?? {};

      if (!targetToolName) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter "toolName". Specify which tool to execute.' }],
          isError: true,
        };
      }

      // Verify the tool exists in our index
      const tool = router.getToolSchema(targetToolName);
      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: `Tool "${targetToolName}" not found. Use mcp_search_tools to discover available tools first.`,
            },
          ],
          isError: true,
        };
      }

      if (!callToolFn) {
        return {
          content: [{ type: 'text', text: 'Tool execution is not available. No callToolFn was configured.' }],
          isError: true,
        };
      }

      try {
        const result = await callToolFn(targetToolName, toolArgs);

        // Normalize result to text
        if (result && typeof result === 'object' && 'content' in result) {
          // Already MCP CallToolResult format
          return result as CallToolResult;
        }

        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text }],
          isError: false,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Tool execution failed: ${errorMessage}` }],
          isError: true,
        };
      }
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
    toolName === 'mcp_execute_tool'
  );
}
