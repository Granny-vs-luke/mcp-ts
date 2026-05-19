import type {
  ToolCallRequest,
  ToolRouterCallResult,
  ToolRouterDetailLevel,
  ToolRouterMetaToolNames,
  ToolSchemaRequest,
  ToolSchemaResult,
  ToolSearchRequest,
  ToolSearchResult
} from "./types.js";

export interface MetaToolContext {
  metaToolNames: ToolRouterMetaToolNames;
  initialize?: () => Promise<void>;
  searchTools(request: ToolSearchRequest): Promise<ToolSearchResult[]>;
  listServers(query?: string): Array<{ serverId: string; serverName: string; toolCount: number }>;
  getToolSchemas(request: ToolSchemaRequest): ToolSchemaResult[];
  callTool(request: ToolCallRequest): Promise<unknown>;
}

export async function executeMetaTool(
  context: MetaToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<ToolRouterCallResult> {
  try {
    switch (name) {
      case context.metaToolNames.searchTools: {
        const detail = detailArg(args.detail) ?? "brief";
        const results = await context.searchTools({
          query: stringArg(args.query),
          serverId: stringArg(args.serverId),
          serverName: stringArg(args.serverName),
          limit: numberArg(args.limit),
          detail
        });
        return success(renderSearchResults(results, detail), { results });
      }
      case context.metaToolNames.listServers: {
        await context.initialize?.();
        const result = context.listServers(stringArg(args.query) ?? "");
        return success(formatJson(result), { servers: result });
      }
      case context.metaToolNames.getToolSchemas: {
        await context.initialize?.();
        const detail = detailArg(args.detail) ?? "detailed";
        const schema = context.getToolSchemas({
          toolIds: requiredStringArrayArg(args.toolIds, "toolIds")
        });
        return success(renderSchemaResults(schema, detail), { results: schema });
      }
      case context.metaToolNames.callTool: {
        const result = await context.callTool({
          toolId: requiredStringArg(args.toolId, "toolId"),
          args: objectArg(args.args)
        });
        return success(formatJson(result), { result });
      }
      default:
        return error(`Unknown toolrouter meta tool "${name}".`);
    }
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}

function success(text: string, structuredContent?: unknown): ToolRouterCallResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: false
  };
}

function error(text: string): ToolRouterCallResult {
  return {
    content: [{ type: "text", text }],
    isError: true
  };
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
    return [...required].map((fieldName) => `- \`${fieldName}\` (any, required)`);
  }

  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return ["- `value` (any)"];
  }

  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return ["*(no parameters)*"];
  }

  return entries.map(([fieldName, field]) => {
    const fieldType = schemaType(field);
    const suffix = required.has(fieldName) ? ", required" : "";
    return `- \`${fieldName}\` (${fieldType}${suffix})`;
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
