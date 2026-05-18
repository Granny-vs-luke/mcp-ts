import type { IndexedTool, ToolCallRequest, ToolRouterPolicy, ToolSearchRequest } from "./types.js";

export function normalizeSourceId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "source";
}

export function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function toolAddress(sourceId: string, toolName: string): string {
  return `${sourceId}.${toolName}`;
}

export function matchesSearchScope(tool: IndexedTool, request: ToolSearchRequest): boolean {
  if (request.sourceId && tool.sourceId !== request.sourceId) return false;
  if (
    request.sourceName &&
    !tool.sourceName.toLowerCase().includes(request.sourceName.toLowerCase())
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
  const source = tokenize(`${tool.sourceId} ${tool.sourceName}`);
  const description = tokenize(tool.description);

  // Keep prior weighting intent: name > source > description.
  return [
    ...name,
    ...name,
    ...name,
    ...source,
    ...source,
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

export async function assertToolAllowed(
  policy: ToolRouterPolicy | undefined,
  request: ToolCallRequest,
  tool: IndexedTool
): Promise<void> {
  const address = toolAddress(tool.sourceId, tool.toolName);

  if (policy?.allowTools?.length) {
    const allowed = policy.allowTools.some((pattern) => wildcardMatch(pattern, address));
    if (!allowed) {
      throw new Error(`Policy denied tool call to "${address}": not in allowTools.`);
    }
  }

  if (policy?.denyTools?.some((pattern) => wildcardMatch(pattern, address))) {
    throw new Error(`Policy denied tool call to "${address}": matched denyTools.`);
  }

  if (policy?.denyDestructiveTools && tool.annotations?.destructiveHint === true) {
    const approved = await policy.approveToolCall?.({ ...request, tool });
    if (!approved) {
      throw new Error(`Policy denied tool call to "${address}": destructive tool requires approval.`);
    }
  }
}
