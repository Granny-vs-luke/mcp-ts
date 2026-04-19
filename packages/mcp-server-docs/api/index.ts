import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, McpDocsServer } from "../src/server.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// We use the wrapper instance for persistent state (doc index)
const serverWrapper = new McpDocsServer();
let initialized = false;

/**
 * Main Vercel API handler for MCP Streamable HTTP
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 2. Ensure server is initialized (only once per instance)
  if (!initialized) {
    await serverWrapper.initialize();
    initialized = true;
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode for serverless
      enableJsonResponse: true,
    });

    // Cleanup on close
    res.on("close", () => {
      transport.close().catch(() => {});
    });

    // Use the core McpServer instance from the wrapper
    await serverWrapper.server.connect(transport);
    
    // 3. Handle the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Vercel MCP Error] ${message}`);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
