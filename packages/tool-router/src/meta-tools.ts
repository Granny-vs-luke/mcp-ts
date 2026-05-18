import type { ToolRouterMetaTool, ToolRouterMetaToolNames } from "./types.js";

export const DEFAULT_TOOLROUTER_META_TOOL_NAMES: ToolRouterMetaToolNames = {
  searchTools: "search_tools",
  listSources: "list_sources",
  getToolSchema: "get_tool_schema",
  callTool: "call_tool"
};

export function createMetaTools(names: ToolRouterMetaToolNames = DEFAULT_TOOLROUTER_META_TOOL_NAMES): ToolRouterMetaTool[] {
  return [
    {
      name: names.searchTools,
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
      name: names.listSources,
      description: "List connected tool sources and indexed tool counts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional source id or name filter." }
        }
      }
    },
    {
      name: names.getToolSchema,
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
      name: names.callTool,
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
