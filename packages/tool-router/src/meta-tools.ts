import type { ToolRouterMetaTool } from "./types.js";

export const TOOLROUTER_SEARCH_TOOLS = "toolrouter_search_tools";
export const TOOLROUTER_LIST_SOURCES = "toolrouter_list_sources";
export const TOOLROUTER_GET_TOOL_SCHEMA = "toolrouter_get_tool_schema";
export const TOOLROUTER_CALL_TOOL = "toolrouter_call_tool";

export const TOOLROUTER_META_TOOL_NAMES = [
  TOOLROUTER_SEARCH_TOOLS,
  TOOLROUTER_LIST_SOURCES,
  TOOLROUTER_GET_TOOL_SCHEMA,
  TOOLROUTER_CALL_TOOL
] as const;

export function isToolRouterMetaTool(name: string): boolean {
  return (TOOLROUTER_META_TOOL_NAMES as readonly string[]).includes(name);
}

export function createMetaTools(): ToolRouterMetaTool[] {
  return [
    {
      name: TOOLROUTER_SEARCH_TOOLS,
      description:
        "Search connected tool sources without loading every tool schema into context. Use this first to find candidate tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language tool search query." },
          sourceId: { type: "string", description: "Optional exact source id filter." },
          sourceName: { type: "string", description: "Optional source name fragment filter." },
          limit: { type: "number", description: "Maximum result count." }
        }
      }
    },
    {
      name: TOOLROUTER_LIST_SOURCES,
      description: "List connected tool sources and indexed tool counts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional source id or name filter." }
        }
      }
    },
    {
      name: TOOLROUTER_GET_TOOL_SCHEMA,
      description: "Get the full input schema for one discovered tool before calling it.",
      inputSchema: {
        type: "object",
        properties: {
          sourceId: { type: "string", description: "Exact source id returned by search." },
          sourceName: { type: "string", description: "Optional source name fragment." },
          toolName: { type: "string", description: "Exact tool name returned by search." }
        },
        required: ["toolName"]
      }
    },
    {
      name: TOOLROUTER_CALL_TOOL,
      description: "Proxy execution to a discovered tool on the correct source.",
      inputSchema: {
        type: "object",
        properties: {
          sourceId: { type: "string", description: "Exact source id returned by search." },
          sourceName: { type: "string", description: "Optional source name fragment." },
          toolName: { type: "string", description: "Exact tool name to execute." },
          args: { type: "object", description: "Arguments matching the tool input schema." }
        },
        required: ["toolName"]
      }
    }
  ];
}
