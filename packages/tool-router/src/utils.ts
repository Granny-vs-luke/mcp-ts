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

export function scoreTool(tool: IndexedTool, query = ""): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
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
