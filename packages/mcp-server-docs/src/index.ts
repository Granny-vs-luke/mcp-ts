import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpDocsServer } from "./server.js";

async function main() {
  const server = new McpDocsServer();
  await server.initialize();
  
  const transport = new StdioServerTransport();
  await server.server.connect(transport);
  
  console.error("mcp-ts Docs MCP server running on stdio");
  
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch(console.error);
