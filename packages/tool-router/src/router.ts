import { createMetaTools, DEFAULT_TOOLROUTER_META_TOOL_NAMES } from "./meta-tools.js";
import type {
  IndexedTool,
  ToolCallRequest,
  ToolDefinition,
  ToolRouterMetaToolNames,
  ToolRouterCallResult,
  ToolRouterMetaTool,
  ToolRouterOptions,
  ToolSchemaResult,
  ToolSchemaRequest,
  ToolSearchRequest,
  ToolSearchResult,
  ToolSource
} from "./types.js";
import { normalizeSourceId } from "./utils.js";
import { BM25SearchStrategy } from "./search.js";
import { PolicyEnforcer } from "./policy.js";

export class ToolRouter {
  private sources = new Map<string, ToolSource>();
  private indexedTools: IndexedTool[] = [];
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private maxSearchResults: number;
  private metaToolNames: ToolRouterMetaToolNames;
  private searchStrategy: import("./types.js").SearchStrategy;
  private policyEnforcer: PolicyEnforcer;

  constructor(private options: ToolRouterOptions) {
    this.maxSearchResults = options.maxSearchResults ?? 10;
    this.searchStrategy = options.searchStrategy ?? new BM25SearchStrategy();
    this.policyEnforcer = new PolicyEnforcer(options.policy);
    this.metaToolNames = {
      ...DEFAULT_TOOLROUTER_META_TOOL_NAMES,
      ...(options.metaToolNames ?? {})
    };

    const metaNames = [
      this.metaToolNames.searchTools,
      this.metaToolNames.listSources,
      this.metaToolNames.getToolSchema,
      this.metaToolNames.callTool
    ];
    if (new Set(metaNames).size !== metaNames.length) {
      const duplicates = metaNames.filter((item, index) => metaNames.indexOf(item) !== index);
      throw new Error(`Invalid meta-tool configuration: duplicate names detected (${[...new Set(duplicates)].join(", ")}).`);
    }

    for (const source of options.sources) {
      this.sources.set(source.id, source);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    if (!this.initializePromise) {
      this.initializePromise = this.rebuildIndex();
    }
    await this.initializePromise;
  }

  async refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh();
    }
    await this.refreshPromise;
  }

  private async rebuildIndex(): Promise<void> {
    const next: IndexedTool[] = [];
    const seenSourceIds = new Set<string>();
    const activeMetaToolNames = new Set(this.getMetaTools().map((t) => t.name));

    try {
      for (const source of this.options.sources) {
        const sourceId = normalizeSourceId(source.id);
        if (seenSourceIds.has(sourceId)) {
          throw new Error(`Duplicate tool source id "${sourceId}".`);
        }
        seenSourceIds.add(sourceId);
        this.sources.set(sourceId, { ...source, id: sourceId });

        const listed = await source.listTools();
        for (const tool of listed.tools) {
          if (activeMetaToolNames.has(tool.name)) {
            throw new Error(`Tool collision: Source "${sourceId}" exposes a tool named "${tool.name}" which conflicts with a configured meta-tool.`);
          }
          next.push(this.toIndexedTool(source, sourceId, tool));
        }
      }
      this.indexedTools = next;
      this.initialized = true;
    } finally {
      this.initializePromise = null;
    }
  }

  private async performRefresh(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
    }
    this.initialized = false;
    try {
      for (const source of this.options.sources) {
        await source.refresh?.();
      }
      if (!this.initializePromise) {
        this.initializePromise = this.rebuildIndex();
      }
      await this.initializePromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  getMetaTools(): ToolRouterMetaTool[] {
    const tools = createMetaTools(this.metaToolNames);
    if (!this.options.excludeMetaTools?.length) {
      return tools;
    }
    const excluded = new Set(this.options.excludeMetaTools);
    return tools.filter((tool) => !excluded.has(tool.name));
  }

  async searchTools(request: ToolSearchRequest): Promise<ToolSearchResult[]> {
    await this.ensureInitialized();
    const limit = Math.min(request.limit ?? this.maxSearchResults, 100);
    return this.searchStrategy.search(this.indexedTools, request, limit);
  }

  listSources(query = ""): Array<{ sourceId: string; sourceName: string; toolCount: number }> {
    const lowered = query.toLowerCase();
    const counts = new Map<string, { sourceId: string; sourceName: string; toolCount: number }>();

    for (const [sourceId, source] of this.sources.entries()) {
      counts.set(sourceId, {
        sourceId,
        sourceName: source.name ?? sourceId,
        toolCount: 0
      });
    }

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

  getToolSchema(request: ToolSchemaRequest): ToolSchemaResult {
    const tool = this.resolveTool(request);
    if (!tool) {
      throw new Error(`Tool "${request.toolName}" was not found.`);
    }
    return {
      sourceId: tool.sourceId,
      sourceName: tool.sourceName,
      toolName: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema
    };
  }

  async callTool(request: ToolCallRequest): Promise<unknown> {
    await this.ensureInitialized();
    const tool = this.resolveTool(request);
    if (!tool) {
      throw new Error(`Tool "${request.toolName}" was not found.`);
    }

    await this.policyEnforcer.assertToolAllowed(request, tool);

    const source = this.sources.get(tool.sourceId);
    if (!source) {
      throw new Error(`Source "${tool.sourceId}" is no longer registered.`);
    }

    return source.callTool(tool.toolName, request.args ?? {});
  }

  async executeMetaTool(name: string, args: Record<string, unknown>): Promise<ToolRouterCallResult> {
    try {
      switch (name) {
        case this.metaToolNames.searchTools: {
          const results = await this.searchTools({
            query: stringArg(args.query),
            sourceId: stringArg(args.sourceId),
            sourceName: stringArg(args.sourceName),
            limit: numberArg(args.limit)
          });
          return this.success(formatJson(results), results);
        }
        case this.metaToolNames.listSources: {
          await this.ensureInitialized();
          const result = this.listSources(stringArg(args.query) ?? "");
          return this.success(formatJson(result), result);
        }
        case this.metaToolNames.getToolSchema: {
          await this.ensureInitialized();
          const schema = this.getToolSchema({
            sourceId: stringArg(args.sourceId),
            sourceName: stringArg(args.sourceName),
            toolName: requiredStringArg(args.toolName, "toolName")
          });
          return this.success(formatJson(schema), schema);
        }
        case this.metaToolNames.callTool: {
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
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    if (this.initialized) {
      return;
    }
    await this.initialize();
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
