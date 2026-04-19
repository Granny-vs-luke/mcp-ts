/**
 * SchemaCompressor — Utilities for reducing tool schema token overhead.
 *
 * Provides compact representations of tools (name + description only,
 * no inputSchema) and token savings estimation.
 *
 * @packageDocumentation
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolIndex } from './tool-index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A minimal tool representation containing only what an LLM needs to
 * *decide whether* to use a tool.  The full `inputSchema` is deferred.
 */
export interface CompactTool {
  name: string;
  description?: string;
  /**
   * Human-readable hint about the expected parameters.
   * e.g. "(location: string, unit?: 'celsius' | 'fahrenheit')"
   */
  parameterHint?: string;
}

export interface CompressionStats {
  /** Estimated tokens for the *full* tool list. */
  fullTokens: number;
  /** Estimated tokens for the *compact* tool list. */
  compactTokens: number;
  /** Absolute token savings. */
  savedTokens: number;
  /** Percentage savings as a human-readable string, e.g. "82.3%". */
  savingsPercent: string;
}

// ---------------------------------------------------------------------------
// SchemaCompressor
// ---------------------------------------------------------------------------

export class SchemaCompressor {
  /**
   * Convert a full MCP Tool definition to a compact summary.
   *
   * The compact form omits `inputSchema` entirely and optionally generates
   * a short `parameterHint` from the schema's top-level properties.
   */
  static toCompact(tool: Tool): CompactTool {
    const compact: CompactTool = {
      name: tool.name,
      description: tool.description,
    };

    // Build parameter hint from schema
    if (tool.inputSchema && typeof tool.inputSchema === 'object') {
      const schema = tool.inputSchema as {
        properties?: Record<string, { type?: string; enum?: unknown[] }>;
        required?: string[];
      };

      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const parts: string[] = [];

        for (const [key, val] of Object.entries(schema.properties)) {
          const type = val?.type ?? 'any';
          const enumSuffix =
            val?.enum && Array.isArray(val.enum)
              ? `: ${val.enum.map((e) => `'${e}'`).join(' | ')}`
              : `: ${type}`;

          parts.push(required.has(key) ? `${key}${enumSuffix}` : `${key}?${enumSuffix}`);
        }

        if (parts.length > 0) {
          compact.parameterHint = `(${parts.join(', ')})`;
        }
      }
    }

    return compact;
  }

  /**
   * Convert an array of tools to compact form, optionally limiting the count.
   */
  static compactAll(tools: Tool[], options?: { maxTools?: number }): CompactTool[] {
    const limited = options?.maxTools ? tools.slice(0, options.maxTools) : tools;
    return limited.map((t) => SchemaCompressor.toCompact(t));
  }

  /**
   * Estimate token savings from using compact vs full tool schemas.
   */
  static estimateSavings(tools: Tool[]): CompressionStats {
    let fullTokens = 0;
    let compactTokens = 0;

    for (const tool of tools) {
      fullTokens += ToolIndex.estimateTokens(tool);

      // Compact form: name + description + parameterHint
      const compact = SchemaCompressor.toCompact(tool);
      const text = [compact.name, compact.description ?? '', compact.parameterHint ?? ''].join(' ');
      // Simple estimation for compact: ~4 chars per token for plain text
      compactTokens += Math.ceil(text.length / 4);
    }

    const saved = fullTokens - compactTokens;
    const pct = fullTokens > 0 ? ((saved / fullTokens) * 100).toFixed(1) : '0.0';

    return {
      fullTokens,
      compactTokens,
      savedTokens: saved,
      savingsPercent: `${pct}%`,
    };
  }
}
