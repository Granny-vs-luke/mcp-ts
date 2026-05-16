import { createMetaTools, TOOLROUTER_CALL_TOOL, TOOLROUTER_GET_TOOL_SCHEMA, TOOLROUTER_LIST_SOURCES, TOOLROUTER_SEARCH_TOOLS } from "./meta-tools.js";
import type {
  IndexedTool,
  ToolCallRequest,
  ToolDefinition,
  ToolRouterCallResult,
  ToolRouterMetaTool,
  ToolRouterOptions,
  ToolSchemaRequest,
  ToolSearchRequest,
  ToolSearchResult,
  ToolSource
} from "./types.js";
import { assertToolAllowed, matchesSearchScope, normalizeSourceId, scoreTool } from "./utils.js";

export class ToolRouter {
  private sources = new Map<string, ToolSource>();
  private indexedTools: IndexedTool[] = [];
  private initialized = false;
  private maxSearchResults: number;

  constructor(private options: ToolRouterOptions) {
    this.maxSearchResults = options.maxSearchResults ?? 10;
    for (const source of options.sources) {
      this.sources.set(source.id, source);
    }
  }

  async initialize(): Promise<void> {
    const next: IndexedTool[] = [];
    const seenSourceIds = new Set<string>();

    for (const source of this.options.sources) {
      const sourceId = normalizeSourceId(source.id);
      if (seenSourceIds.has(sourceId)) {
        throw new Error(`Duplicate tool source id "${sourceId}".`);
      }
      seenSourceIds.add(sourceId);
      this.sources.set(sourceId, { ...source, id: sourceId });

      const listed = await source.listTools();
      for (const tool of listed.tools) {
        next.push(this.toIndexedTool(source, sourceId, tool));
      }
    }

    this.indexedTools = next;
    this.initialized = true;
  }

  async refresh(): Promise<void> {
    this.initialized = false;
    await this.ensureInitialized();
  }

  getMetaTools(): ToolRouterMetaTool[] {
    return createMetaTools();
  }

  async searchTools(request: ToolSearchRequest): Promise<ToolSearchResult[]> {
    await this.ensureInitialized();
    const limit = Math.min(request.limit ?? this.maxSearchResults, 100);

    return this.indexedTools
      .filter((tool) => matchesSearchScope(tool, request))
      .map((tool) => ({ tool, score: scoreTool(tool, request.query) }))
      .filter((entry) => !request.query || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.toolName.localeCompare(b.tool.toolName))
      .slice(0, limit)
      .map(({ tool, score }) => ({
        sourceId: tool.sourceId,
        sourceName: tool.sourceName,
        toolName: tool.toolName,
        description: tool.description,
        annotations: tool.annotations,
        score
      }));
  }

  listSources(query = ""): Array<{ sourceId: string; sourceName: string; toolCount: number }> {
    const lowered = query.toLowerCase();
    const counts = new Map<string, { sourceId: string; sourceName: string; toolCount: number }>();

    for (const tool of this.indexedTools) {
      const current =
        counts.get(tool.sourceId) ??
        { sourceId: tool.sourceId, sourceName: tool.sourceName, toolCount: 0 };
      current.toolCount += 1;
      counts.set(tool.sourceId, current);
    }

    return [...counts.values()].filter(
      (source) =>
        !lowered ||
        source.sourceId.toLowerCase().includes(lowered) ||
        source.sourceName.toLowerCase().includes(lowered)
    );
  }

  getToolSchema(request: ToolSchemaRequest): IndexedTool {
    const tool = this.resolveTool(request);
    if (!tool) {
      throw new Error(`Tool "${request.toolName}" was not found.`);
    }
    return { ...tool };
  }

  async callTool(request: ToolCallRequest): Promise<unknown> {
    await this.ensureInitialized();
    const tool = this.resolveTool(request);
    if (!tool) {
      throw new Error(`Tool "${request.toolName}" was not found.`);
    }

    await assertToolAllowed(this.options.policy, request, tool);

    const source = this.sources.get(tool.sourceId);
    if (!source) {
      throw new Error(`Source "${tool.sourceId}" is no longer registered.`);
    }

    return source.callTool(tool.toolName, request.args ?? {});
  }

  async executeMetaTool(name: string, args: Record<string, unknown>): Promise<ToolRouterCallResult> {
    try {
      switch (name) {
        case TOOLROUTER_SEARCH_TOOLS: {
          const results = await this.searchTools({
            query: stringArg(args.query),
            sourceId: stringArg(args.sourceId),
            sourceName: stringArg(args.sourceName),
            limit: numberArg(args.limit)
          });
          return this.success(formatJson(results), results);
        }
        case TOOLROUTER_LIST_SOURCES: {
          await this.ensureInitialized();
          const result = this.listSources(stringArg(args.query) ?? "");
          return this.success(formatJson(result), result);
        }
        case TOOLROUTER_GET_TOOL_SCHEMA: {
          const schema = this.getToolSchema({
            sourceId: stringArg(args.sourceId),
            sourceName: stringArg(args.sourceName),
            toolName: requiredStringArg(args.toolName, "toolName")
          });
          return this.success(formatJson(schema), schema);
        }
        case TOOLROUTER_CALL_TOOL: {
          const result = await this.callTool({
            sourceId: stringArg(args.sourceId),
            sourceName: stringArg(args.sourceName),
            toolName: requiredStringArg(args.toolName, "toolName"),
            args: objectArg(args.args)
          });
          return this.success(formatJson(result), result);
        }
        default:
          return this.error(`Unknown toolrouter meta tool "${name}".`);
      }
    } catch (error) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private resolveTool(request: ToolSchemaRequest): IndexedTool | undefined {
    const matches = this.indexedTools.filter((tool) => {
      if (tool.toolName !== request.toolName) return false;
      if (request.sourceId && tool.sourceId !== normalizeSourceId(request.sourceId)) return false;
      if (
        request.sourceName &&
        !tool.sourceName.toLowerCase().includes(request.sourceName.toLowerCase())
      ) {
        return false;
      }
      return true;
    });

    if (matches.length > 1) {
      const sources = matches.map((tool) => tool.sourceId).join(", ");
      throw new Error(
        `Tool "${request.toolName}" exists on multiple sources: ${sources}. Provide sourceId.`
      );
    }

    return matches[0];
  }

  private toIndexedTool(source: ToolSource, sourceId: string, tool: ToolDefinition): IndexedTool {
    return {
      sourceId,
      sourceName: source.name ?? sourceId,
      toolName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    };
  }

  private success(text: string, structuredContent?: unknown): ToolRouterCallResult {
    return {
      content: [{ type: "text", text }],
      isError: false,
      structuredContent
    };
  }

  private error(text: string): ToolRouterCallResult {
    return {
      content: [{ type: "text", text }],
      isError: true
    };
  }
}

export async function createToolRouter(options: ToolRouterOptions): Promise<ToolRouter> {
  const router = new ToolRouter(options);
  await router.initialize();
  return router;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required parameter "${name}".`);
  }
  return value;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectArg(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('"args" must be an object.');
  }
  return value as Record<string, unknown>;
}
