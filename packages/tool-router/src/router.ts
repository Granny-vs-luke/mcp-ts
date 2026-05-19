import { createMetaTools, DEFAULT_TOOLROUTER_META_TOOL_NAMES } from "./meta-tools.js";
import type {
  IndexedTool,
  ToolCallRequest,
  ToolDefinition,
  ToolRouterCallResult,
  ToolRouterDetailLevel,
  ToolRouterMetaTool,
  ToolRouterMetaToolNames,
  ToolRouterOptions,
  ToolSchemaRequest,
  ToolSchemaResult,
  ToolSearchRequest,
  ToolSearchResult,
  ToolServer
} from "./types.js";
import type { PinnedToolResult, VisibleTools } from "./types.js";
import { normalizeServerId } from "./utils.js";
import { BM25SearchStrategy } from "./search.js";
import { PolicyEnforcer, wildcardMatch } from "./policy.js";

export class ToolRouter {
  private servers = new Map<string, ToolServer>();
  private indexedTools: IndexedTool[] = [];
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private maxSearchResults: number;
  private metaToolNames: ToolRouterMetaToolNames;
  private searchStrategy: import("./types.js").SearchStrategy;
  private policyEnforcer: PolicyEnforcer;
  private pinnedToolNames: Set<string>;
  private excludedToolPatterns: string[];

  constructor(private options: ToolRouterOptions) {
    this.maxSearchResults = options.maxSearchResults ?? 10;
    this.searchStrategy = options.searchStrategy ?? new BM25SearchStrategy();
    this.policyEnforcer = new PolicyEnforcer(options.policy);
    this.pinnedToolNames = new Set((options.pinnedTools ?? []).map(normalizeToolReference));
    this.excludedToolPatterns = (options.excludeTools ?? []).map(normalizeToolReference);
    this.metaToolNames = {
      ...DEFAULT_TOOLROUTER_META_TOOL_NAMES,
      ...(options.metaToolNames ?? {})
    };

    const metaNames = [
      this.metaToolNames.searchTools,
      this.metaToolNames.listServers,
      this.metaToolNames.getToolSchemas,
      this.metaToolNames.callTool
    ];
    if (new Set(metaNames).size !== metaNames.length) {
      const duplicates = metaNames.filter((item, index) => metaNames.indexOf(item) !== index);
      throw new Error(
        `Invalid meta-tool configuration: duplicate names detected (${[...new Set(duplicates)].join(", ")}).`
      );
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
    const seenServerIds = new Set<string>();
    const activeMetaToolNames = new Set(this.getMetaTools().map((t) => t.name));
    const nextServers = new Map<string, ToolServer>();

    try {
      for (const server of this.options.servers) {
        const serverId = normalizeServerId(server.id);
        if (seenServerIds.has(serverId)) {
          throw new Error(`Duplicate tool server id "${serverId}".`);
        }
        seenServerIds.add(serverId);
        nextServers.set(serverId, { ...server, id: serverId });

        const listed = await server.listTools();
        for (const tool of listed.tools) {
          if (this.isExcludedTool(serverId, tool.name)) {
            continue;
          }
          if (activeMetaToolNames.has(tool.name)) {
            throw new Error(
              `Tool collision: Server "${serverId}" exposes a tool named "${tool.name}" which conflicts with a configured meta-tool.`
            );
          }
          next.push(this.toIndexedTool(server, serverId, tool));
        }
      }
      this.servers = nextServers;
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
      for (const server of this.options.servers) {
        await server.refresh?.();
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
    const visibleTools = this.indexedTools.filter((tool) =>
      this.policyEnforcer.isToolVisible(tool) && !this.isPinnedTool(tool)
    );
    return this.searchStrategy.search(visibleTools, request, limit);
  }

  getPinnedTools(): PinnedToolResult[] {
    this.assertInitialized();
    return [...this.pinnedToolNames].flatMap((name) => {
      const tool = this.resolvePinnedTool(name);
      return tool
        ? [
            {
              toolId: makeToolId(tool.serverId, tool.toolName),
              serverId: tool.serverId,
              serverName: tool.serverName,
              toolName: tool.toolName,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: tool.annotations
            }
          ]
        : [];
    });
  }

  getVisibleTools(): VisibleTools {
    this.assertInitialized();
    return { pinned: this.getPinnedTools(), metaTools: this.getMetaTools() };
  }

  listServers(query = ""): Array<{ serverId: string; serverName: string; toolCount: number }> {
    this.assertInitialized();
    const lowered = query.toLowerCase();
    const counts = new Map<string, { serverId: string; serverName: string; toolCount: number }>();

    for (const [serverId, server] of this.servers.entries()) {
      counts.set(serverId, {
        serverId,
        serverName: server.name ?? serverId,
        toolCount: 0
      });
    }

    for (const tool of this.indexedTools) {
      const current =
        counts.get(tool.serverId) ??
        { serverId: tool.serverId, serverName: tool.serverName, toolCount: 0 };
      current.toolCount += 1;
      counts.set(tool.serverId, current);
    }

    return [...counts.values()].filter(
      (server) =>
        !lowered ||
        server.serverId.toLowerCase().includes(lowered) ||
        server.serverName.toLowerCase().includes(lowered)
    );
  }

  getToolSchemas(request: ToolSchemaRequest): ToolSchemaResult[] {
    this.assertInitialized();
    return request.toolIds.map((toolId) => {
      const tool = this.resolveToolById(toolId);
      if (!tool) {
        throw new Error(`Tool "${toolId}" was not found.`);
      }
      return {
        toolId: makeToolId(tool.serverId, tool.toolName),
        serverId: tool.serverId,
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema
      };
    });
  }

  async callTool(request: ToolCallRequest): Promise<unknown> {
    await this.ensureInitialized();
    const tool = this.resolveToolById(request.toolId);
    if (!tool) {
      throw new Error(`Tool "${request.toolId}" was not found.`);
    }

    await this.policyEnforcer.assertToolAllowed(request, tool);

    const server = this.servers.get(tool.serverId);
    if (!server) {
      throw new Error(`Server "${tool.serverId}" is no longer registered.`);
    }

    return server.callTool(tool.toolName, request.args ?? {});
  }

  async executeMetaTool(name: string, args: Record<string, unknown>): Promise<ToolRouterCallResult> {
    try {
      switch (name) {
        case this.metaToolNames.searchTools: {
          const detail = detailArg(args.detail) ?? "brief";
          const results = await this.searchTools({
            query: stringArg(args.query),
            serverId: stringArg(args.serverId),
            serverName: stringArg(args.serverName),
            limit: numberArg(args.limit),
            detail
          });
          return this.success(renderSearchResults(results, detail), { results });
        }
        case this.metaToolNames.listServers: {
          await this.ensureInitialized();
          const result = this.listServers(stringArg(args.query) ?? "");
          return this.success(formatJson(result), { servers: result });
        }
        case this.metaToolNames.getToolSchemas: {
          await this.ensureInitialized();
          const detail = detailArg(args.detail) ?? "detailed";
          const schema = this.getToolSchemas({
            toolIds: requiredStringArrayArg(args.toolIds, "toolIds")
          });
          return this.success(renderSchemaResults(schema, detail), { results: schema });
        }
        case this.metaToolNames.callTool: {
          const result = await this.callTool({
            toolId: requiredStringArg(args.toolId, "toolId"),
            args: objectArg(args.args)
          });
          return this.success(formatJson(result), { result });
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

  private assertInitialized(): void {
    if (!this.initialized || this.initializePromise || this.refreshPromise) {
      throw new Error("ToolRouter is not initialized. Call initialize() before reading the tool catalog.");
    }
  }

  private resolveToolById(toolId: string): IndexedTool | undefined {
    const { serverId, toolName } = parseToolId(toolId);
    return this.indexedTools.find(
      (tool) => tool.serverId === normalizeServerId(serverId) && tool.toolName === toolName
    );
  }

  private resolvePinnedTool(reference: string): IndexedTool | undefined {
    const tool = reference.includes(".")
      ? this.resolveToolById(reference)
      : this.indexedTools.find((t) => t.toolName === reference);

    return tool && this.policyEnforcer.isToolVisible(tool) ? tool : undefined;
  }

  private isPinnedTool(tool: IndexedTool): boolean {
    return (
      this.pinnedToolNames.has(makeToolId(tool.serverId, tool.toolName)) ||
      this.pinnedToolNames.has(tool.toolName)
    );
  }

  private isExcludedTool(serverId: string, toolName: string): boolean {
    const address = makeToolId(serverId, toolName);
    return this.excludedToolPatterns.some((pattern) => {
      if (!pattern.includes(".")) {
        return wildcardMatch(pattern, toolName);
      }
      return wildcardMatch(pattern, address);
    });
  }

  private toIndexedTool(server: ToolServer, serverId: string, tool: ToolDefinition): IndexedTool {
    return {
      serverId,
      serverName: server.name ?? serverId,
      toolName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations
    };
  }

  private success(text: string, structuredContent?: unknown): ToolRouterCallResult {
    return {
      content: [{ type: "text", text }],
      ...(structuredContent === undefined ? {} : { structuredContent }),
      isError: false
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

function requiredStringArrayArg(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`Missing required parameter "${name}".`);
  }
  return value;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detailArg(value: unknown): ToolRouterDetailLevel | undefined {
  return value === "brief" || value === "detailed" || value === "full" ? value : undefined;
}

function objectArg(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('"args" must be an object.');
  }
  return value as Record<string, unknown>;
}

function makeToolId(serverId: string, toolName: string): string {
  return `${serverId}.${toolName}`;
}

function parseToolId(toolId: string): { serverId: string; toolName: string } {
  const separatorIndex = toolId.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === toolId.length - 1) {
    throw new Error(`Invalid toolId "${toolId}". Expected "serverId.toolName".`);
  }

  return {
    serverId: toolId.slice(0, separatorIndex),
    toolName: toolId.slice(separatorIndex + 1)
  };
}

function normalizeToolReference(reference: string): string {
  if (!reference.includes(".")) {
    return reference;
  }

  const { serverId, toolName } = parseToolId(reference);
  return makeToolId(normalizeServerId(serverId), toolName);
}

function renderSearchResults(results: ToolSearchResult[], detail: ToolRouterDetailLevel): string {
  if (results.length === 0) {
    return detail === "full" ? "[]" : "No tools matched the query.";
  }

  if (detail === "full") {
    return formatJson(results);
  }

  if (detail === "detailed") {
    return results
      .map((tool, index) =>
        [
          `${index + 1}. ${tool.toolName}`,
          `Tool ID: ${tool.toolId}`,
          `Server: ${tool.serverId}${tool.serverName && tool.serverName !== tool.serverId ? ` (${tool.serverName})` : ""}`,
          tool.description ? `Description: ${tool.description}` : null
        ]
          .filter(Boolean)
          .join("\n")
      )
      .join("\n\n");
  }

  return results
    .map((tool) => `- Tool ID: ${tool.toolId} - ${tool.description || "No description."}`)
    .join("\n");
}

function renderSchemaResults(results: ToolSchemaResult[], detail: ToolRouterDetailLevel): string {
  if (results.length === 0) {
    return detail === "full" ? "[]" : "No tools matched the query.";
  }

  if (detail === "full") {
    return formatJson(results);
  }

  return results
    .map((tool) => {
      const lines = [`### ${tool.toolName}`, `Tool ID: ${tool.toolId}`];
      if (tool.description) {
        lines.push("", tool.description);
      }
      if (detail === "brief") {
        return lines.join("\n");
      }
      lines.push("", "**Parameters**");
      lines.push(...renderSchemaFields(tool.inputSchema));
      if (tool.outputSchema !== undefined) {
        lines.push("", "**Returns**");
        lines.push(...renderSchemaFields(tool.outputSchema));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderSchemaFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return ["- `value` (any)"];
  }

  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  const required = Array.isArray(record.required)
    ? new Set(
        record.required.filter((item): item is string => typeof item === "string")
      )
    : new Set<string>();

  if (
    (!properties || typeof properties !== "object" || Array.isArray(properties)) &&
    required.size > 0
  ) {
    return [...required].map((name) => `- \`${name}\` (any, required)`);
  }

  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return ["- `value` (any)"];
  }

  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return ["*(no parameters)*"];
  }

  return entries.map(([name, field]) => {
    const fieldType = schemaType(field);
    const suffix = required.has(name) ? ", required" : "";
    return `- \`${name}\` (${fieldType}${suffix})`;
  });
}

function schemaType(schema: unknown): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "any";
  }

  const record = schema as Record<string, unknown>;
  if (typeof record.type === "string" && record.type.length > 0) {
    if (record.type === "array") {
      return `${schemaType(record.items)}[]`;
    }
    return record.type;
  }

  if (record.properties && typeof record.properties === "object") {
    return "object";
  }

  return "any";
}
