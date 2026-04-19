import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import matter from "gray-matter";
import Fuse from "fuse.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path resolution for different environments (Local Source, Local Dist, Vercel)
function resolveDocsDir(): string {
  const pathsToTry = [
    // 1. Local dist folder (Bundled with package)
    path.resolve(__dirname, "docs"),
    // 2. Vercel deployment root
    path.resolve(process.cwd(), "dist/docs"),
    path.resolve(process.cwd(), "packages/mcp-server-docs/dist/docs"),
    // 3. Fallback to root docs folder (Local development)
    path.resolve(__dirname, "../../../docs"),
  ];

  for (const docsPath of pathsToTry) {
    if (fs.existsSync(docsPath)) {
      console.error(`[MCP Docs] Found docs at: ${docsPath}`);
      return docsPath;
    }
  }

  console.error(`[MCP Docs] WARNING: Could not find docs folder in any of: ${pathsToTry.join(", ")}`);
  return pathsToTry[pathsToTry.length - 1]; // Fallback to last search path
}

const DOCS_DIR = resolveDocsDir();

interface DocPage {
  title: string;
  path: string;
  content: string;
  description?: string;
}

/**
 * MCP Documentation Server for mcp-ts
 */
/**
 * Creates and configures the MCP Documentation Server.
 */
export function createServer(): McpServer {
  const server = new McpDocsServer();
  // Initialization (loading docs) is handled by the caller or inside the server wrapper
  // Note: For serverless, we might want a way to initialize it once.
  return server.server;
}

/**
 * MCP Documentation Server Wrapper
 */
export class McpDocsServer {
  public server: McpServer;
  private static fuse: Fuse<DocPage> | null = null;
  private static docsMap: Map<string, DocPage> = new Map();
  private static initialized = false;

  constructor() {
    this.server = new McpServer({
      name: "mcp-ts-docs-server",
      version: "1.0.0",
    });

    this.registerTools();
    this.server.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  /**
   * Initialize doc loading and search indexing (Singleton)
   */
  async initialize() {
    if (McpDocsServer.initialized) return;

    console.error("Initializing documentation hub...");
    const files = await glob("**/*.md", { cwd: DOCS_DIR });
    const docs: DocPage[] = [];

    for (const file of files) {
      const doc = await this.parseDocFile(file);
      if (doc) {
        docs.push(doc);
        McpDocsServer.docsMap.set(doc.path, doc);
      }
    }

    this.initializeSearch(docs);
    McpDocsServer.initialized = true;
    console.error(`Ready! Indexed ${docs.length} documentation pages.`);
  }

  private async parseDocFile(file: string): Promise<DocPage | null> {
    const fullPath = path.join(DOCS_DIR, file);
    try {
      const rawContent = await readFile(fullPath, { encoding: "utf-8" });
      const { data, content: body } = matter(rawContent);
      const relativePath = file.replace(/\\/g, "/").replace(/\.md$/, "");
      
      return {
        title: data.title || path.basename(file, ".md"),
        path: relativePath,
        content: body,
        description: data.description,
      };
    } catch (error) {
      console.error(`Failed to load ${file}:`, error);
      return null;
    }
  }

  private initializeSearch(docs: DocPage[]) {
    McpDocsServer.fuse = new Fuse(docs, {
      keys: [
        { name: "title", weight: 0.7 },
        { name: "description", weight: 0.5 },
        { name: "content", weight: 0.3 },
      ],
      threshold: 0.6,
      includeMatches: true,
      ignoreLocation: true, // Search everywhere in the document
    });
  }

  private registerTools() {
    // 1. List Documentation Hierarchy
    this.server.registerTool(
      "list_docs",
      { description: "View the hierarchical structure of mcp-ts documentation." },
      () => this.handleListDocs()
    );

    // 2. Retrieve Specific Doc Content
    this.server.registerTool(
      "get_doc",
      {
        description: "Get full Markdown content of a specific page.",
        inputSchema: {
          path: z.string().describe("Relative path (e.g., 'introduction' or 'adapters/ai-sdk')."),
        },
      },
      (args) => this.handleGetDoc(args)
    );

    // 3. Search Documentation
    this.server.registerTool(
      "search_docs",
      {
        description: "Fuzzy search across all documentation titles and content.",
        inputSchema: {
          query: z.string().describe("Search term or phrase."),
        },
      },
      (args) => this.handleSearchDocs(args)
    );
  }

  private async handleListDocs() {
    try {
      const docsJson = await this.readJson("docs.json");
      return this.success(JSON.stringify(docsJson.navigation, null, 2));
    } catch (error) {
      return this.error(`Failed to load docs structure: ${this.errorMessage(error)}`);
    }
  }

  private async handleGetDoc({ path: docPath }: { path: string }) {
    const normalized = docPath.replace(/^\//, "").replace(/\.md$/, "");
    const doc = McpDocsServer.docsMap.get(normalized);

    if (!doc) {
      return this.error(
        `Page not found: ${docPath}. Available paths: ${Array.from(McpDocsServer.docsMap.keys()).join(", ")}`
      );
    }

    const frontmatter = `---\ntitle: ${doc.title}\npath: ${doc.path}\n---\n\n`;
    return this.success(frontmatter + doc.content);
  }

  private async handleSearchDocs({ query }: { query: string }) {
    if (!McpDocsServer.fuse) return this.error("Search index not ready.");

    const results = McpDocsServer.fuse.search(query).slice(0, 15);
    if (results.length === 0) return this.success(`No results found for "${query}".`);

    const output = results.map(({ item }) => {
      const highlightedContent = this.getHighlightedSnippet(item, query);
      const url = `https://mcp-ts.zonlabs.com/docs/${item.path}`;
      
      return [
        `Title: ${item.title}`,
        `Link: ${url}`,
        `Page: ${item.path}`,
        `Content: ${highlightedContent}`
      ].join("\n");
    }).join("\n\n---\n\n");

    return this.success(`Search results for "${query}":\n\n${output}`);
  }

  /**
   * Generates a snippet and highlights matching terms with <mark><b>
   */
  private getHighlightedSnippet(doc: DocPage, query: string): string {
    const text = doc.content;
    const q = query.toLowerCase();
    const lowText = text.toLowerCase();
    
    let idx = lowText.indexOf(q);
    let matchedTerm = query;

    // If exact query not found, search for individual words
    if (idx === -1) {
      const words = q.split(/\s+/).filter(w => w.length > 3);
      for (const word of words) {
        idx = lowText.indexOf(word);
        if (idx !== -1) {
          matchedTerm = word;
          break;
        }
      }
    }

    // Default to start of content if no match found
    if (idx === -1) {
      const base = doc.description || text;
      return base.length > 150 ? base.substring(0, 150).trim() + "..." : base;
    }
    
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + 140);
    let snippet = text.substring(start, end).replace(/\n/g, " ").trim();
    
    // Simple highlighting for the specific matched term
    const regex = new RegExp(`(${this.escapeRegex(matchedTerm)})`, "gi");
    snippet = snippet.replace(regex, "<mark><b>$1</b></mark>");
    
    return (start > 0 ? "..." : "") + snippet + (end < text.length ? "..." : "");
  }

  private escapeRegex(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --- Helpers ---

  private async readJson(filename: string) {
    const content = await readFile(path.join(DOCS_DIR, filename), { encoding: "utf-8" });
    return JSON.parse(content);
  }

  private success(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }

  private error(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async close() {
    await this.server.close();
  }
}
