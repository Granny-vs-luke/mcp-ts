import type { IndexedTool, ToolSource } from "../types.js";
import { normalizeSourceId } from "./tool-index.js";

// ---------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------

/**
 * Sanitizes a string to be a valid JavaScript identifier.
 */
export function sanitizeIdentifier(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&");
}

// ---------------------------------------------------------------------------
// TypeScript interface generation (ported from UTCP code_mode_utcp_client.ts)
// ---------------------------------------------------------------------------

/**
 * Converts a JSON Schema to a TypeScript type string.
 */
function jsonSchemaToTsType(schema: Record<string, unknown> | undefined): string {
  if (!schema || typeof schema !== "object") return "any";

  if (schema.enum && Array.isArray(schema.enum)) {
    return (schema.enum as unknown[])
      .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
      .join(" | ");
  }

  switch (schema.type) {
    case "object": {
      const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (!props) return "{ [key: string]: any }";
      const required = (schema.required as string[]) ?? [];
      const entries = Object.entries(props).map(([key, propSchema]) => {
        const opt = required.includes(key) ? "" : "?";
        const propType = jsonSchemaToTsType(propSchema);
        return `${key}${opt}: ${propType}`;
      });
      return `{ ${entries.join("; ")} }`;
    }
    case "array": {
      if (!schema.items) return "any[]";
      const itemSchema = schema.items as Record<string, unknown>;
      const itemType = Array.isArray(itemSchema)
        ? itemSchema.map((s) => jsonSchemaToTsType(s as Record<string, unknown>)).join(" | ")
        : jsonSchemaToTsType(itemSchema);
      return `(${itemType})[]`;
    }
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      if (Array.isArray(schema.type)) {
        return (schema.type as string[])
          .map((t) => {
            switch (t) {
              case "string": return "string";
              case "number": case "integer": return "number";
              case "boolean": return "boolean";
              case "null": return "null";
              case "object": return "object";
              case "array": return "any[]";
              default: return "any";
            }
          })
          .join(" | ");
      }
      return "any";
  }
}

/**
 * Generates the inner content of a TypeScript interface from a JSON Schema.
 */
function jsonSchemaToObjectContent(schema: Record<string, unknown> | undefined): string {
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    return "    [key: string]: any;";
  }

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const lines: string[] = [];

  for (const [propName, propSchema] of Object.entries(properties)) {
    const isRequired = required.includes(propName);
    const optionalMarker = isRequired ? "" : "?";
    const description = propSchema.description ? String(propSchema.description) : "";
    const tsType = jsonSchemaToTsType(propSchema);

    if (description) {
      lines.push(`    /** ${escapeComment(description)} */`);
    }
    lines.push(`    ${propName}${optionalMarker}: ${tsType};`);
  }

  return lines.length > 0 ? lines.join("\n") : "    [key: string]: any;";
}

function escapeComment(text: string): string {
  return text.replace(/\*\//g, "*\\/").replace(/\n/g, " ");
}

/**
 * Generates a TypeScript interface definition for a single tool,
 * grouped under its source namespace.
 */
export function toolToTypeScriptInterface(tool: IndexedTool): string {
  const sanitizedSource = sanitizeIdentifier(tool.sourceId);
  const sanitizedTool = sanitizeIdentifier(tool.toolName);
  const accessPattern = `${sanitizedSource}.${sanitizedTool}`;

  const inputContent = jsonSchemaToObjectContent(tool.inputSchema);

  return `
namespace ${sanitizedSource} {
  interface ${sanitizedTool}Input {
${inputContent}
  }
}

/**
 * ${escapeComment(tool.description || "No description")}
 * Source: ${tool.sourceId}
 * Access as: ${accessPattern}(args)
 */`;
}

/**
 * Generates all TypeScript interface definitions for a set of indexed tools.
 */
export function generateAllInterfaces(tools: IndexedTool[]): string {
  const interfaces = tools.map((tool) => toolToTypeScriptInterface(tool));
  return `// Auto-generated TypeScript interfaces for available tools\n${interfaces.join("\n\n")}`;
}

/**
 * Generates a lookup map of tool name → TypeScript interface string.
 * Keys use the format "sourceId.toolName".
 */
export function generateInterfaceMap(tools: IndexedTool[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tool of tools) {
    const key = `${tool.sourceId}.${tool.toolName}`;
    map[key] = toolToTypeScriptInterface(tool);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Namespace function code generation
// ---------------------------------------------------------------------------

/**
 * Generates JavaScript code to set up namespace functions in the sandbox.
 * Each source becomes a namespace object (e.g. `global.github = {}`) and
 * each tool becomes a synchronous function on that namespace
 * (e.g. `global.github.get_issue = function(args) { ... }`).
 *
 * Uses `applySyncPromise` so tool calls are synchronous from the sandbox's
 * perspective — no `await` needed (but `await` also works).
 */
export function generateNamespaceBridgeCode(
  tools: IndexedTool[],
  sources: Map<string, ToolSource>,
): string {
  const parts: string[] = [];
  const namespaces = new Set<string>();

  for (const tool of tools) {
    const sanitizedSource = sanitizeIdentifier(tool.sourceId);
    const sanitizedTool = sanitizeIdentifier(tool.toolName);

    if (!namespaces.has(sanitizedSource)) {
      namespaces.add(sanitizedSource);
      parts.push(`globalThis.${sanitizedSource} = globalThis.${sanitizedSource} || {};`);
    }

    // applySyncPromise blocks the isolate until the host-side async tool call completes.
    // This makes `github.get_issue({...})` work without `await`.
    // `await github.get_issue({...})` also works because awaiting a non-Promise is a no-op.
    parts.push(`
      globalThis.${sanitizedSource}.${sanitizedTool} = function(args) {
        var resultJson = __callToolRef.applySyncPromise(undefined, [${JSON.stringify(tool.sourceId)}, ${JSON.stringify(tool.toolName)}, JSON.stringify(args || {})]);
        var parsed = JSON.parse(resultJson);
        if (!parsed.success) throw new Error(parsed.error);
        return parsed.result;
      };
    `);
  }

  return parts.join("\n");
}

/**
 * Generates JavaScript code for console, searchTools, callTool, and
 * interface introspection helpers in the sandbox.
 */
export function generateBootstrapCode(
  interfacesString: string,
  interfaceMapJson: string,
): string {
  return `
    "use strict";

    // Console bridge
    const __stringify = (a) => typeof a === "object" && a !== null ? JSON.stringify(a, null, 2) : String(a);
    globalThis.console = {
      log: (...args) => __logRef.applySync(undefined, args.map(__stringify)),
      error: (...args) => __errorRef.applySync(undefined, args.map(__stringify)),
      warn: (...args) => __warnRef.applySync(undefined, args.map(__stringify)),
      info: (...args) => __infoRef.applySync(undefined, args.map(__stringify)),
    };

    // Low-level callTool escape hatch (requires await)
    globalThis.callTool = function(sourceId, toolName, args) {
      var resultJson = __callToolRef.applySyncPromise(undefined, [sourceId, toolName, JSON.stringify(args || {})]);
      var parsed = JSON.parse(resultJson);
      if (!parsed.success) throw new Error(parsed.error);
      return parsed.result;
    };

    // searchTools (requires await)
    globalThis.searchTools = function(query, limit) {
      var resultJson = __searchToolsRef.applySyncPromise(undefined, [query || "", limit || 10]);
      return JSON.parse(resultJson);
    };

    // getToolSchema
    globalThis.getToolSchema = function(sourceId, toolName) {
      var resultJson = __getToolSchemaRef.applySyncPromise(undefined, [sourceId, toolName]);
      return JSON.parse(resultJson);
    };

    // Interface introspection
    globalThis.__interfaces = ${JSON.stringify(interfacesString)};
    const __interfaceMap = ${interfaceMapJson};
    globalThis.__getToolInterface = function(toolName) {
      return __interfaceMap[toolName] || null;
    };

    // Input passthrough
    globalThis.input = typeof __input !== "undefined" ? __input : undefined;
  `;
}
