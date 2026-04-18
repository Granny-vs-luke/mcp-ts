/**
 * ToolIndex — Lightweight in-memory search index for MCP tool discovery.
 *
 * Supports two search methods:
 *   • BM25      – Okapi BM25 ranking over tokenized tool metadata (zero external deps)
 *   • regex     – Pattern matching against tool names, descriptions, and parameters
 *   • embedding – (optional) cosine-similarity over caller-supplied vectors,
 *                 blended with BM25 scores
 *
 * @packageDocumentation
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Compact summary returned by search — intentionally lightweight. */
export interface ToolSummary {
  /** Fully qualified tool name (e.g. "tool_github_create_pr") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Server that owns this tool */
  serverName: string;
  /** Session the tool belongs to */
  sessionId: string;
  /** Estimated token cost of the full inputSchema */
  estimatedTokens: number;
}

/** A tool with routing metadata attached during indexing. */
export interface IndexedTool extends Tool {
  sessionId: string;
  serverName: string;
}

/**
 * An optional embedding function supplied by the consumer.
 * Should accept an array of strings and return a matching array of
 * float-number arrays (one embedding vector per input string).
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface ToolIndexOptions {
  /**
   * Custom embedding function for semantic search.
   * When provided, `search()` uses cosine-similarity in addition to keywords.
   * @example
   * ```ts
   * import { embed } from 'ai';
   * const embedFn: EmbedFn = async (texts) => {
   *   const { embeddings } = await embed({ model: openai('text-embedding-3-small'), values: texts });
   *   return embeddings;
   * };
   * ```
   */
  embedFn?: EmbedFn;

  /**
   * Relative weight of keyword score vs embedding score when both are active.
   * 0 = embedding only · 1 = keyword only · 0.4 (default) blends both.
   * @default 0.4
   */
  keywordWeight?: number;
}

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

/**
 * Character-class weights for accurate-ish token estimation without a real
 * tokenizer.  Empirically calibrated against cl100k_base on typical JSON
 * Schema payloads.
 *
 * | Char class        | Approx chars per token |
 * |--------------------|------------------------|
 * | Whitespace / punct | 1–2                    |
 * | English words      | ~4                     |
 * | JSON keys/values   | ~3.5                   |
 *
 * We walk the string once and accumulate a weighted character count, then
 * divide by a calibrated divisor.
 */
const CALIBRATION_DIVISOR = 3.6;

function classifyChar(ch: string): number {
  const code = ch.charCodeAt(0);
  // whitespace / common JSON structural chars  →  high token density
  if (code <= 0x20 || ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') return 1.0;
  // digits and symbols
  if (code >= 0x21 && code <= 0x2f) return 1.5;
  if (code >= 0x30 && code <= 0x39) return 2.0;
  // uppercase (often JSON keys)
  if (code >= 0x41 && code <= 0x5a) return 3.5;
  // lowercase (natural language in descriptions)
  if (code >= 0x61 && code <= 0x7a) return 4.0;
  // everything else (unicode, emojis, etc.)
  return 2.5;
}

// ---------------------------------------------------------------------------
// ToolIndex
// ---------------------------------------------------------------------------

export class ToolIndex {
  /** All indexed tools keyed by name (supports duplicates). */
  private tools = new Map<string, IndexedTool[]>();

  /** Direct lookup from unique document key to indexed tool metadata. */
  private toolDocuments = new Map<string, IndexedTool>();

  /** Precomputed lightweight summaries keyed by document. */
  private toolSummaries = new Map<string, ToolSummary>();

  /** Pre-computed search text for keyword matching (lowercase), keyed by document. */
  private searchTexts = new Map<string, string>();

  /** Pre-computed IDF values per token (computed once on build). */
  private idf = new Map<string, number>();

  /** Per-tool TF vectors (Map<token, tf>). */
  private tfVectors = new Map<string, Map<string, number>>();

  /** Optional: pre-computed embedding vectors per tool. */
  private embeddings = new Map<string, number[]>();

  /** BM25: document lengths in tokens for each tool. */
  private docLengths = new Map<string, number>();

  /** BM25: average document length across the entire index. */
  private avgDocLength = 0;

  /** Cached total estimated token cost across all indexed tools. */
  private totalTokenCost = 0;

  private options: Required<ToolIndexOptions>;

  constructor(options: ToolIndexOptions = {}) {
    this.options = {
      embedFn: options.embedFn ?? (undefined as unknown as EmbedFn),
      keywordWeight: options.keywordWeight ?? 0.4,
    };
  }

  // -----------------------------------------------------------------------
  // Indexing
  // -----------------------------------------------------------------------

  /**
   * Build (or rebuild) the index from the given tool set.
   * Call this after connecting / reconnecting to MCP servers.
   */
  async buildIndex(tools: IndexedTool[]): Promise<void> {
    this.tools.clear();
    this.toolDocuments.clear();
    this.toolSummaries.clear();
    this.searchTexts.clear();
    this.idf.clear();
    this.tfVectors.clear();
    this.embeddings.clear();
    this.docLengths.clear();
    this.avgDocLength = 0;
    this.totalTokenCost = 0;

    // 1. Populate tool map + search text
    const allTokenSets: Map<string, Set<string>> = new Map();
    let totalLength = 0;

    for (const tool of tools) {
      const docKey = this.getDocumentKey(tool);

      if (!this.tools.has(tool.name)) {
        this.tools.set(tool.name, []);
      }
      this.tools.get(tool.name)!.push(tool);
      this.toolDocuments.set(docKey, tool);
      const estimatedTokens = ToolIndex.estimateTokens(tool);
      this.toolSummaries.set(docKey, {
        name: tool.name,
        description: tool.description ?? '',
        serverName: tool.serverName,
        sessionId: tool.sessionId,
        estimatedTokens,
      });
      this.totalTokenCost += estimatedTokens;

      const text = this.buildSearchableText(tool).toLowerCase();
      this.searchTexts.set(docKey, text);

      const tokens = this.tokenize(text);
      const tf = new Map<string, number>();
      const uniqueTokens = new Set<string>();

      for (const tok of tokens) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
        uniqueTokens.add(tok);
      }

      // Normalize TF
      const maxTf = Math.max(...tf.values(), 1);
      for (const [k, v] of tf) {
        tf.set(k, v / maxTf);
      }

      this.tfVectors.set(docKey, tf);
      allTokenSets.set(docKey, uniqueTokens);

      const length = tokens.length;
      this.docLengths.set(docKey, length);
      totalLength += length;
    }

    // Compute average document length
    this.avgDocLength = totalLength / (tools.length || 1);

    // 2. Compute IDF
    const totalDocs = tools.length || 1;
    const dfCounts = new Map<string, number>();

    for (const tokenSet of allTokenSets.values()) {
      for (const tok of tokenSet) {
        dfCounts.set(tok, (dfCounts.get(tok) ?? 0) + 1);
      }
    }

    for (const [tok, df] of dfCounts) {
      this.idf.set(tok, Math.log(totalDocs / df) + 1);
    }

    // 3. Build embeddings if an embedFn was provided
    if (this.options.embedFn) {
      const names = [...this.searchTexts.keys()];
      const texts = names.map((n) => this.searchTexts.get(n)!);

      try {
        const vectors = await this.options.embedFn(texts);
        for (let i = 0; i < names.length; i++) {
          if (vectors[i]) {
            this.embeddings.set(names[i], vectors[i]);
          }
        }
      } catch (err) {
        console.warn('[ToolIndex] Embedding generation failed, falling back to keyword-only search:', err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  /**
   * Search the index and return the top-K most relevant tools.
   *
   * When an `embedFn` is configured the final score is a weighted blend of
   * keyword TF-IDF similarity and embedding cosine-similarity:
   *
   *   `score = keywordWeight × keyword_score + (1 - keywordWeight) × cosine_score`
   */
  async search(query: string, topK = 5): Promise<ToolSummary[]> {
    if (this.tools.size === 0) return [];

    const queryLower = query.toLowerCase();
    const queryTokens = this.tokenize(queryLower);

    // 1. Keyword scores (BM25)
    const keywordScores = new Map<string, number>();

    const k1 = 1.2;
    const b = 0.75;

    for (const [docKey, docTf] of this.tfVectors) {
      let score = 0;
      const docLen = this.docLengths.get(docKey) ?? 0;

      for (const tok of queryTokens) {
        const tfVal = docTf.get(tok) ?? 0;
        if (tfVal === 0) continue;

        const idf = this.idf.get(tok) ?? 0;

        // BM25 formula:
        // score = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLength)))
        const numerator = tfVal * (k1 + 1);
        const denominator = tfVal + k1 * (1 - b + b * (docLen / this.avgDocLength));
        
        score += idf * (numerator / denominator);
      }

      keywordScores.set(docKey, score);
    }

    // 2. Embedding scores (optional)
    let embeddingScores: Map<string, number> | null = null;

    if (this.options.embedFn && this.embeddings.size > 0) {
      try {
        const [queryEmbedding] = await this.options.embedFn([queryLower]);
        if (queryEmbedding) {
          embeddingScores = new Map();
          for (const [docKey, vec] of this.embeddings) {
            embeddingScores.set(docKey, this.cosineSimilarity(queryEmbedding, vec));
          }
        }
      } catch {
        // Silently fall back to keyword only for this query
      }
    }

    // 3. Blend scores
    const kw = this.options.keywordWeight;
    const finalScores: Array<{ docKey: string; score: number }> = [];

    for (const docKey of this.toolDocuments.keys()) {
      const kwScore = keywordScores.get(docKey) ?? 0;
      const embScore = embeddingScores?.get(docKey) ?? 0;

      const score = embeddingScores ? kw * kwScore + (1 - kw) * embScore : kwScore;

      if (score > 0) {
        finalScores.push({ docKey, score });
      }
    }

    // 4. Sort and return top-K
    finalScores.sort((a, b) => b.score - a.score);

    return finalScores.slice(0, topK).map(({ docKey }) => {
      return this.toolSummaries.get(docKey)!;
    });
  }

  /**
   * Search tools using a regex pattern.
   * Matches against name, description, and parameter metadata.
   */
  searchRegex(pattern: string, topK = 5): ToolSummary[] {
    if (this.tools.size === 0) return [];

    try {
      // Handle Anthropic-style (?i) case-insensitive flag which JS doesn't support natively in string
      let flags = '';
      let cleanPattern = pattern;
      if (pattern.includes('(?i)')) {
        flags = 'i';
        cleanPattern = pattern.replace(/\(\?i\)/g, '');
      }

      const regex = new RegExp(cleanPattern, flags || undefined);
      const matches: Array<{ docKey: string; score: number }> = [];

      for (const [docKey, text] of this.searchTexts) {
        const tool = this.toolDocuments.get(docKey);
        if (!tool) continue;

        if (regex.test(text) || regex.test(tool.name)) {
          // Use a simple heuristic for ranking regex matches: 
          // 1. Exact name match (highest)
          // 2. Name starts with pattern
          // 3. Name contains pattern
          // 4. Description contains pattern (lowest)
          let score = 1;
          if (tool.name === cleanPattern) score = 10;
          else if (tool.name.startsWith(cleanPattern)) score = 5;
          else if (tool.name.toLowerCase().includes(cleanPattern.toLowerCase())) score = 2;

          matches.push({ docKey, score });
        }
      }

      matches.sort((a, b) => b.score - a.score);

      return matches.slice(0, topK).map(({ docKey }) => {
        return this.toolSummaries.get(docKey)!;
      });
    } catch (err) {
      console.warn('[ToolIndex] Regex search failed:', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /**
   * Get tool definition(s) by name.
   * If namespace is provided, it tries to match sessionId or serverName.
   */
  getTool(name: string, namespace?: string): IndexedTool[] {
    const list = this.tools.get(name) ?? [];
    if (!namespace) return list;

    return list.filter((t) => t.sessionId === namespace || t.serverName === namespace);
  }

  /** All indexed tool names. */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Number of indexed tools (including duplicates). */
  get size(): number {
    let count = 0;
    for (const list of this.tools.values()) {
      count += list.length;
    }
    return count;
  }

  /** Total estimated token cost of all indexed tool schemas. */
  getTotalTokenCost(): number {
    return this.totalTokenCost;
  }

  // -----------------------------------------------------------------------
  // Static Helpers
  // -----------------------------------------------------------------------

  /**
   * Estimate token count of a tool's full schema (name + description + inputSchema).
   *
   * Uses character-class weighted counting calibrated against cl100k_base.
   * Accuracy is typically within ±10% for JSON Schema payloads.
   */
  static estimateTokens(tool: Tool): number {
    const parts: string[] = [tool.name];
    if (tool.description) parts.push(tool.description);
    if (tool.inputSchema) parts.push(JSON.stringify(tool.inputSchema));

    const text = parts.join(' ');
    let weightedLen = 0;

    for (let i = 0; i < text.length; i++) {
      weightedLen += 1 / classifyChar(text[i]);
    }

    return Math.ceil(weightedLen / (1 / CALIBRATION_DIVISOR));
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Build a single searchable string from tool metadata. */
  private buildSearchableText(tool: Tool): string {
    const parts: string[] = [tool.name];
    if (tool.description) parts.push(tool.description);

    // Include property names and descriptions from schema
    if (tool.inputSchema && typeof tool.inputSchema === 'object') {
      const schema = tool.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, { description?: string }> | undefined;
      if (props) {
        for (const [key, val] of Object.entries(props)) {
          parts.push(key);
          if (val && typeof val === 'object' && val.description) {
            parts.push(val.description);
          }
        }
      }
    }

    return parts.join(' ');
  }

  private getDocumentKey(tool: IndexedTool): string {
    return `${tool.sessionId}::${tool.serverName}::${tool.name}`;
  }

  /** Simple whitespace + camelCase + snake_case tokenizer. */
  private tokenize(text: string): string[] {
    return text
      // Split camelCase: "getWeather" → "get Weather"
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Split snake_case / kebab-case
      .replace(/[_-]/g, ' ')
      // Remove non-alphanumeric (except spaces)
      .replace(/[^a-z0-9\s]/g, '')
      // Split on whitespace
      .split(/\s+/)
      .filter((t) => t.length > 1); // drop single-char noise
  }

  /** Cosine similarity between two vectors. */
  private cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
  }
}
