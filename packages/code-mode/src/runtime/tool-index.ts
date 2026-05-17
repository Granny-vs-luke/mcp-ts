import type { IndexedTool, ToolSearchResult, ToolSource } from "../types.js";

/**
 * Normalizes a source ID to a safe, lowercase identifier.
 */
export function normalizeSourceId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "source";
}

/**
 * Indexes all tools from the given sources.
 * Resolves tools from each source and flattens into a single list.
 */
export async function indexSources(sources: ToolSource[]): Promise<IndexedTool[]> {
  const indexed: IndexedTool[] = [];
  const seenSourceIds = new Set<string>();

  for (const source of sources) {
    const sourceId = normalizeSourceId(source.id);
    if (seenSourceIds.has(sourceId)) {
      throw new Error(`Duplicate tool source id "${sourceId}".`);
    }
    seenSourceIds.add(sourceId);

    const listed = await source.listTools();
    for (const tool of listed.tools) {
      indexed.push({
        sourceId,
        sourceName: source.name ?? sourceId,
        toolName: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      });
    }
  }

  return indexed;
}

/**
 * Scores a tool against a search query using word-match heuristics.
 */
function scoreTool(tool: IndexedTool, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (terms.length === 0) return 1;

  const name = tool.toolName.toLowerCase();
  const source = `${tool.sourceId} ${tool.sourceName}`.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (name === term) score += 10;
    if (name.includes(term)) score += 6;
    if (source.includes(term)) score += 4;
    if (description.includes(term)) score += 2;
  }

  return score;
}

/**
 * Searches the index by query with optional source filters.
 */
export function searchToolIndex(
  index: IndexedTool[],
  query?: string,
  limit = 10,
  sourceId?: string,
): ToolSearchResult[] {
  return index
    .filter((tool) => {
      if (sourceId && tool.sourceId !== sourceId) return false;
      return true;
    })
    .map((tool) => ({ tool, score: scoreTool(tool, query ?? "") }))
    .filter((entry) => !query || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.toolName.localeCompare(b.tool.toolName))
    .slice(0, Math.min(limit, 100))
    .map(({ tool, score }) => ({
      sourceId: tool.sourceId,
      sourceName: tool.sourceName,
      toolName: tool.toolName,
      description: tool.description,
      annotations: tool.annotations,
      score,
    }));
}

/**
 * Resolves a specific tool from the index by sourceId + toolName.
 */
export function resolveTool(
  index: IndexedTool[],
  toolName: string,
  sourceId?: string,
): IndexedTool | undefined {
  const matches = index.filter((tool) => {
    if (tool.toolName !== toolName) return false;
    if (sourceId && tool.sourceId !== normalizeSourceId(sourceId)) return false;
    return true;
  });

  if (matches.length > 1) {
    const sources = matches.map((t) => t.sourceId).join(", ");
    throw new Error(
      `Tool "${toolName}" exists on multiple sources: ${sources}. Provide sourceId.`
    );
  }

  return matches[0];
}

/**
 * Lists connected sources with tool counts.
 */
export function listSourcesFromIndex(
  index: IndexedTool[],
): Array<{ sourceId: string; sourceName: string; toolCount: number }> {
  const counts = new Map<string, { sourceId: string; sourceName: string; toolCount: number }>();

  for (const tool of index) {
    const current =
      counts.get(tool.sourceId) ??
      { sourceId: tool.sourceId, sourceName: tool.sourceName, toolCount: 0 };
    current.toolCount += 1;
    counts.set(tool.sourceId, current);
  }

  return [...counts.values()];
}
