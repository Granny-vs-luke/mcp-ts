/**
 * ToolRouter — Middleware layer for intelligent MCP tool selection.
 *
 * Sits between your AI framework adapter and MultiSessionClient to reduce
 * context window usage. Supports three strategies:
 *
 *  • `all`    — Pass through every tool (backward-compatible default)
 *  • `search` — Expose only meta-tools; LLM discovers tools on-demand
 *  • `groups` — Expose tools from active groups only
 *
 * Inspired by Anthropic's `defer_loading` + `tool_search_tool` pattern.
 *
 * @example
 * ```ts
 * import { ToolRouter } from '@mcp-ts/sdk/shared';
 * import { AIAdapter } from '@mcp-ts/sdk/adapters/ai';
 *
 * const router = new ToolRouter(multiSessionClient, {
 *   strategy: 'search',
 *   maxTools: 5,
 * });
 *
 * const tools = await AIAdapter.getTools(multiSessionClient, { toolRouter: router });
 * ```
 *
 * @packageDocumentation
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolIndex, type IndexedTool, type ToolSummary, type EmbedFn } from './tool-index.js';
import { SchemaCompressor, type CompactTool } from './schema-compressor.js';
import {
  createSearchToolDefinition,
  createGetSchemaToolDefinition,
  createExecuteToolDefinition,
} from './meta-tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolRouterStrategy = 'all' | 'search' | 'groups';

export interface ToolRouterOptions {
  /**
   * Strategy for tool selection.
   *
   *  • `all`    — Expose all tools (default, backward-compatible)
   *  • `search` — Expose only meta-tools; LLM discovers real tools via search
   *  • `groups` — Expose only tools from active groups
   *
   * @default 'all'
   */
  strategy?: ToolRouterStrategy;

  /**
   * Maximum tools to expose to the LLM at once.
   * Only applies to `groups` strategy and search results.
   * @default 40
   */
  maxTools?: number;

  /**
   * Tool groups configuration — map of group name to tool names.
   * When not provided, groups are auto-generated from server names.
   *
   * @example
   * ```ts
   * groups: {
   *   database: ['query_db', 'list_tables', 'describe_table'],
   *   github: ['create_pr', 'list_issues', 'search_code'],
   * }
   * ```
   */
  groups?: Record<string, string[]>;

  /**
   * Active groups (when `strategy='groups'`).
   * Only tools in these groups are exposed. Empty = all groups active.
   */
  activeGroups?: string[];

  /**
   * Whether to use compact schemas (name + description + parameterHint only, no inputSchema).
   * Reduces token usage but requires 2-turn flow: LLM picks tool → get schema → call.
   * @default false
   */
  compactSchemas?: boolean;

  /**
   * Optional embedding function for semantic search.
   * When not provided, keyword TF-IDF matching is used.
   */
  embedFn?: EmbedFn;

  /**
   * Weight of keyword score vs embedding score (0–1).
   * Only relevant when `embedFn` is provided.
   * @default 0.4
   */
  keywordWeight?: number;
}

/** Information about a tool group. */
export interface ToolGroupInfo {
  tools: string[];
  active: boolean;
}

// ---------------------------------------------------------------------------
// Lightweight MCP client interface (duck-typed to avoid circular deps)
// ---------------------------------------------------------------------------

interface MCPClientLike {
  isConnected(): boolean;
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<any>;
  getServerId?(): string | undefined;
  getServerName?(): string | undefined;
  getSessionId?(): string;
}

interface MultiSessionClientLike {
  getClients(): MCPClientLike[];
}

type ClientInput = MultiSessionClientLike | MCPClientLike[];

// ---------------------------------------------------------------------------
// ToolRouter
// ---------------------------------------------------------------------------

export class ToolRouter {
  private index: ToolIndex;
  private allTools: IndexedTool[] = [];
  private groupsMap = new Map<string, ToolGroupInfo>();
  private strategy: ToolRouterStrategy;
  private maxTools: number;
  private compactSchemas: boolean;
  private activeGroups: Set<string>;
  private customGroups?: Record<string, string[]>;
  private initialized = false;

  constructor(
    private client: ClientInput,
    private options: ToolRouterOptions = {}
  ) {
    this.strategy = options.strategy ?? 'all';
    this.maxTools = options.maxTools ?? 40;
    this.compactSchemas = options.compactSchemas ?? false;
    this.activeGroups = new Set(options.activeGroups ?? []);
    this.customGroups = options.groups;

    this.index = new ToolIndex({
      embedFn: options.embedFn,
      keywordWeight: options.keywordWeight,
    });
  }

  // -----------------------------------------------------------------------
  // Core Public API
  // -----------------------------------------------------------------------

  /**
   * Get tools filtered by the current strategy.
   * This is the main method adapters should call.
   *
   * - `all`    → returns all tools (unchanged behavior)
   * - `search` → returns only meta-tools (search_tools, get_tool_schema, list_tool_groups)
   * - `groups` → returns tools from active groups only
   */
  async getFilteredTools(): Promise<Tool[]> {
    await this.ensureInitialized();

    switch (this.strategy) {
      case 'search':
        return this.getMetaToolDefinitions();

      case 'groups':
        return this.getGroupFilteredTools();

      case 'all':
      default:
        if (this.compactSchemas) {
          // Return tools with inputSchema stripped
          return this.allTools.map((t) => {
            const compact = SchemaCompressor.toCompact(t);
            return {
              name: compact.name,
              description:
                (compact.description ?? '') +
                (compact.parameterHint ? ` Parameters: ${compact.parameterHint}` : ''),
              inputSchema: { type: 'object' as const, properties: {} },
            };
          });
        }
        return [...this.allTools];
    }
  }

  /**
   * Search tools by natural-language query.
   * Works regardless of strategy.
   */
  async searchTools(query: string, topK?: number): Promise<ToolSummary[]> {
    await this.ensureInitialized();
    return this.index.search(query, topK ?? this.maxTools);
  }

  /**
   * Get the full tool definition by name.
   * If tool name is ambiguous, use namespace to specify the server.
   */
  getToolSchema(toolName: string, namespace?: string): IndexedTool | undefined {
    const matches = this.index.getTool(toolName, namespace);

    if (matches.length === 0) return undefined;

    if (matches.length > 1) {
      const servers = matches.map((m) => m.serverName).join(', ');
      throw new Error(
        `Tool "${toolName}" is provided by multiple servers: [${servers}]. ` +
          `Please specify the desired "serverName" as a namespace.`
      );
    }

    return matches[0];
  }

  /**
   * Get compact (schema-less) summaries for all tools.
   */
  getCompactTools(): CompactTool[] {
    return SchemaCompressor.compactAll(this.allTools);
  }

  // -----------------------------------------------------------------------
  // Group Management
  // -----------------------------------------------------------------------

  /** Get all available groups with their tool lists and active status. */
  getGroups(): Map<string, ToolGroupInfo> {
    return new Map(this.groupsMap);
  }

  /** Activate specific groups. Pass empty array to activate all. */
  setActiveGroups(groups: string[]): void {
    this.activeGroups = new Set(groups);
    // Update groupsMap active flags
    for (const [name, info] of this.groupsMap) {
      info.active = this.activeGroups.size === 0 || this.activeGroups.has(name);
    }
  }

  /** Get the names of currently active groups. */
  getActiveGroups(): string[] {
    return [...this.activeGroups];
  }

  // -----------------------------------------------------------------------
  // Stats & Introspection
  // -----------------------------------------------------------------------

  /** Total token cost of all tools if loaded without filtering. */
  getTotalTokenCost(): number {
    return this.index.getTotalTokenCost();
  }

  /** Estimate token cost of the currently filtered tool set. */
  async getFilteredTokenCost(): Promise<number> {
    const tools = await this.getFilteredTools();
    let total = 0;
    for (const tool of tools) {
      total += ToolIndex.estimateTokens(tool);
    }
    return total;
  }

  /** Get compression stats showing savings from current strategy. */
  getCompressionStats() {
    return SchemaCompressor.estimateSavings(this.allTools);
  }

  /** Number of total indexed tools. */
  get totalToolCount(): number {
    return this.allTools.length;
  }

  /** Change strategy at runtime. */
  setStrategy(strategy: ToolRouterStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Force a re-index of tools from all connected clients.
   * Call this after adding/removing MCP server connections.
   */
  async refresh(): Promise<void> {
    this.initialized = false;
    await this.ensureInitialized();
  }

  /**
   * Execute a tool by routing to the correct MCP client.
   * Used by the `mcp_execute_tool` meta-tool to proxy tool calls.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    namespace?: string
  ): Promise<any> {
    await this.ensureInitialized();

    const indexedTool = this.getToolSchema(toolName, namespace);
    if (!indexedTool) {
      throw new Error(
        `Tool "${toolName}" not found${
          namespace ? ` on server "${namespace}"` : ''
        }. Use mcp_search_tools to discover available tools.`
      );
    }

    const clients = this.getClients();
    const targetClient =
      clients.find(
        (c) =>
          typeof c.getSessionId === 'function' &&
          c.getSessionId() === indexedTool.sessionId
      ) ?? clients.find((c) => c.isConnected());

    if (!targetClient) {
      throw new Error(`No connected client found for tool "${toolName}"`);
    }

    return await targetClient.callTool(toolName, args);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Lazy initialization — fetches tools from all connected clients. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    this.allTools = await this.fetchAllTools();
    await this.index.buildIndex(this.allTools);
    this.buildGroups();
    this.initialized = true;
  }

  /** Fetch tools from all connected MCP clients. */
  private async fetchAllTools(): Promise<IndexedTool[]> {
    const clients = this.getClients();
    const result: IndexedTool[] = [];

    for (const client of clients) {
      if (!client.isConnected()) continue;

      try {
        const { tools } = await client.listTools();
        const serverId =
          typeof client.getServerId === 'function' ? client.getServerId() ?? 'unknown' : 'unknown';
        const serverName =
          (typeof client.getServerName === 'function' ? client.getServerName() : undefined) ??
          serverId;
        const sessionId =
          typeof client.getSessionId === 'function' ? client.getSessionId() ?? 'unknown' : 'unknown';

        for (const tool of tools) {
          result.push({
            ...tool,
            serverName: serverName,
            sessionId,
          });
        }
      } catch (err) {
        console.warn('[ToolRouter] Failed to fetch tools from client:', err);
      }
    }

    return result;
  }

  /** Duck-typed client resolution. */
  private getClients(): MCPClientLike[] {
    if (Array.isArray(this.client)) {
      return this.client;
    }
    if (typeof (this.client as MultiSessionClientLike).getClients === 'function') {
      return (this.client as MultiSessionClientLike).getClients();
    }
    // Single client
    return [this.client as unknown as MCPClientLike];
  }

  /** Build group map from custom config or auto-detect from server names. */
  private buildGroups(): void {
    this.groupsMap.clear();

    if (this.customGroups) {
      // Explicit groups
      for (const [name, tools] of Object.entries(this.customGroups)) {
        this.groupsMap.set(name, {
          tools,
          active: this.activeGroups.size === 0 || this.activeGroups.has(name),
        });
      }
    } else {
      // Auto-group by server name
      const serverTools = new Map<string, string[]>();
      for (const tool of this.allTools) {
        const group = tool.serverName;
        if (!serverTools.has(group)) {
          serverTools.set(group, []);
        }
        serverTools.get(group)!.push(tool.name);
      }

      for (const [serverName, tools] of serverTools) {
        this.groupsMap.set(serverName, {
          tools,
          active: this.activeGroups.size === 0 || this.activeGroups.has(serverName),
        });
      }
    }
  }

  /** Return only tools belonging to currently active groups. */
  private getGroupFilteredTools(): Tool[] {
    const activeToolNames = new Set<string>();
    for (const [, info] of this.groupsMap) {
      if (info.active) {
        for (const name of info.tools) {
          activeToolNames.add(name);
        }
      }
    }

    const filtered = this.allTools.filter((t) => activeToolNames.has(t.name));

    if (this.compactSchemas) {
      return filtered.slice(0, this.maxTools).map((t) => {
        const compact = SchemaCompressor.toCompact(t);
        return {
          name: compact.name,
          description:
            (compact.description ?? '') +
            (compact.parameterHint ? ` Parameters: ${compact.parameterHint}` : ''),
          inputSchema: { type: 'object' as const, properties: {} },
        };
      });
    }

    return filtered.slice(0, this.maxTools);
  }

  /** The 3 meta-tool definitions exposed in `search` strategy. */
  private getMetaToolDefinitions(): Tool[] {
    return [
      createSearchToolDefinition(),
      createGetSchemaToolDefinition(),
      createExecuteToolDefinition(),
    ];
  }
}
