import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpDocsServer } from "./server.js";

async function main() {
  const serverWrapper = new McpDocsServer();
  await serverWrapper.initialize();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await serverWrapper.server.connect(transport);

  const PORT = process.env.PORT || 3000;
  const httpServer = createHttpServer(async (req, res) => {
    // Basic CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // In a real local server, we might want to parse the body if not using a framework
      // but StreamableHTTPServerTransport handles standard Node req/res.
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("HTTP Transport Error:", error);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  httpServer.listen(PORT, () => {
    console.error(`MCP Docs Server (Streamable HTTP) running at http://localhost:${PORT}`);
    console.error(`To use with MCP Inspector: npx @modelcontextprotocol/inspector http://localhost:${PORT}`);
  });
}

main().catch(console.error);
