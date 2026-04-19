import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpDocsServer } from "../dist/server.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// We use a singleton just for initialization (shared statics in server.js)
const initializer = new McpDocsServer();
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

  // 2. Ensure global index is initialized (only once per instance)
  if (!initialized) {
    await initializer.initialize();
    initialized = true;
  }

  // 3. Create a fresh McpDocsServer instance for this specific connection
  // This avoids the "Already connected to a transport" error in Vercel.
  const instance = new McpDocsServer();

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
    await instance.server.connect(transport);
    
    // 4. Handle the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : "";
    console.error(`[Vercel MCP Error] ${message}\n${stack}`);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { 
          code: -32603, 
          message: `Internal server error: ${message}`,
          data: { stack } 
        },
        id: null,
      });
    }
  }
}
