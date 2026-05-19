import type { ToolRouterMetaTool, ToolRouterMetaToolNames } from "./types.js";

export const DEFAULT_TOOLROUTER_META_TOOL_NAMES: ToolRouterMetaToolNames = {
  searchTools: "search_tools",
  listServers: "list_servers",
  getToolSchemas: "get_tool_schemas",
  callTool: "call_tool"
};

export function createMetaTools(names: ToolRouterMetaToolNames = DEFAULT_TOOLROUTER_META_TOOL_NAMES): ToolRouterMetaTool[] {
  return [
    {
      name: names.searchTools,
      description:
        "Search connected tool servers without loading every tool schema into context. Use this first to find candidate tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language tool search query." },
          serverId: { type: "string", description: "Optional exact server id filter." },
          serverName: { type: "string", description: "Optional server name fragment filter." },
          limit: { type: "number", description: "Maximum result count." },
          detail: {
            type: "string",
            enum: ["brief", "detailed", "full"],
            description: "Response detail level."
          }
        }
      }
    },
    {
      name: names.listServers,
      description: "List connected tool servers and indexed tool counts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional server id or name filter." }
        }
      }
    },
    {
      name: names.getToolSchemas,
      description: "Get input and output schema details for discovered tools before calling them.",
      inputSchema: {
        type: "object",
        properties: {
          toolIds: {
            type: "array",
            items: { type: "string" },
            description: 'Canonical tool IDs returned by search_tools. Treat them as opaque strings and copy them exactly.'
          },
          detail: {
            type: "string",
            enum: ["brief", "detailed", "full"],
            description: "Response detail level."
          }
        },
        required: ["toolIds"]
      }
    },
    {
      name: names.callTool,
      description: "Proxy execution to a discovered tool on the correct server.",
      inputSchema: {
        type: "object",
        properties: {
          toolId: {
            type: "string",
            description: 'Canonical tool ID returned by search_tools. Treat it as an opaque string and copy it exactly.'
          },
          args: { type: "object", description: "Arguments matching the tool input schema." }
        },
        required: ["toolId"]
      }
    }
  ];
}
