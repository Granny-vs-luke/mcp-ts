import type { IndexedTool, SearchStrategy, ToolSearchRequest, ToolSearchResult } from "./types.js";
import { normalizeServerId } from "./utils.js";

export function matchesSearchScope(tool: IndexedTool, request: ToolSearchRequest): boolean {
  if (request.serverId && tool.serverId !== normalizeServerId(request.serverId)) return false;
  if (
    request.serverName &&
    !tool.serverName.toLowerCase().includes(request.serverName.toLowerCase())
  ) {
    return false;
  }
  return true;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function documentTokens(tool: IndexedTool): string[] {
  const name = tokenize(tool.toolName);
  const server = tokenize(`${tool.serverId} ${tool.serverName}`);
  const description = tokenize(tool.description);

  // Keep prior weighting intent: name > server > description.
  return [
    ...name,
    ...name,
    ...name,
    ...server,
    ...server,
    ...description
  ];
}

export function bm25Scores(tools: IndexedTool[], query = ""): number[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return tools.map(() => 1);
  }

  const docs = tools.map(documentTokens);
  const docLengths = docs.map((d) => d.length);
  const totalLength = docLengths.reduce((sum, n) => sum + n, 0);
  const avgDocLength = tools.length > 0 ? totalLength / tools.length : 1;

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  const n = tools.length;

  return docs.map((doc, index) => {
    const tf = new Map<string, number>();
    for (const term of doc) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    const dl = docLengths[index] || 1;
    let score = 0;

    for (const term of queryTerms) {
      const termFreq = tf.get(term) ?? 0;
      if (termFreq === 0) continue;

      const termDf = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - termDf + 0.5) / (termDf + 0.5));
      const numerator = termFreq * (k1 + 1);
      const denominator = termFreq + k1 * (1 - b + b * (dl / avgDocLength));
      score += idf * (numerator / denominator);
    }

    return score;
  });
}

export class BM25SearchStrategy implements SearchStrategy {
  search(tools: IndexedTool[], request: ToolSearchRequest, limit: number): ToolSearchResult[] {
    const candidates = tools.filter(
      (tool) =>
        matchesSearchScope(tool, request) &&
        !request._pinnedTools?.has(tool.toolName)
    );
    const scores = bm25Scores(candidates, request.query ?? "");

    return candidates
      .map((tool, index) => ({ tool, score: scores[index] ?? 0 }))
      .filter((entry) => !request.query || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.toolName.localeCompare(b.tool.toolName))
      .slice(0, limit)
      .map(({ tool, score }) => ({
        toolId: `${tool.serverId}.${tool.toolName}`,
        serverId: tool.serverId,
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: tool.description,
        score
      }));
  }
}
