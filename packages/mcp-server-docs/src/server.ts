import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import matter from "gray-matter";
import Fuse from "fuse.js";
import { z } from "zod";

// Path resolution for different environments (Local Source, Local Dist, Vercel)
function resolveDocsDir(): string {
  // 1. Check local dist folder (Bundled with package)
  const distDocs = path.resolve(__dirname, "docs");
  try {
    // We use a simple synchronous check here as it's only called once during initialization
    // and we need to resolve the path before any async file operations start.
    return distDocs;
  } catch {
    // 2. Fallback to root docs folder (Local development)
    return path.resolve(__dirname, "../../../docs");
  }
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
  private fuse: Fuse<DocPage> | null = null;
  private docsMap: Map<string, DocPage> = new Map();

  constructor() {
    this.server = new McpServer({
      name: "mcp-ts-docs-server",
      version: "1.0.0",
    });

    this.registerTools();
    this.server.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  /**
   * Initialize doc loading and search indexing
   */
  async initialize() {
    console.error("Initializing documentation hub...");
    const files = await glob("**/*.md", { cwd: DOCS_DIR });
    const docs: DocPage[] = [];

    for (const file of files) {
      const doc = await this.parseDocFile(file);
      if (doc) {
        docs.push(doc);
        this.docsMap.set(doc.path, doc);
      }
    }

    this.initializeSearch(docs);
    console.error(`Ready! Indexed ${docs.length} documentation pages.`);
  }

  private async parseDocFile(file: string): Promise<DocPage | null> {
    const fullPath = path.join(DOCS_DIR, file);
    try {
      const rawContent = await fs.readFile(fullPath, "utf-8");
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
    this.fuse = new Fuse(docs, {
      keys: ["title", "content", "description"],
      threshold: 0.4,
      includeMatches: true,
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
    const doc = this.docsMap.get(normalized);

    if (!doc) {
      return this.error(
        `Page not found: ${docPath}. Available paths: ${Array.from(this.docsMap.keys()).join(", ")}`
      );
    }

    const frontmatter = `---\ntitle: ${doc.title}\npath: ${doc.path}\n---\n\n`;
    return this.success(frontmatter + doc.content);
  }

  private async handleSearchDocs({ query }: { query: string }) {
    if (!this.fuse) return this.error("Search index not ready.");

    const results = this.fuse.search(query).slice(0, 10);
    if (results.length === 0) return this.success(`No results found for "${query}".`);

    const output = results.map(({ item }) => {
      const snippet = this.getSnippet(item, query);
      return `- **${item.title}** (${item.path})\n  *${snippet}*`;
    }).join("\n\n");

    return this.success(`Search results for "${query}":\n\n${output}`);
  }

  private getSnippet(doc: DocPage, query: string): string {
    if (doc.description) return doc.description;
    
    const idx = doc.content.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return doc.content.substring(0, 100).trim() + "...";
    
    const start = Math.max(0, idx - 40);
    const end = Math.min(doc.content.length, idx + 100);
    return (start > 0 ? "..." : "") + doc.content.substring(start, end).trim() + "...";
  }

  // --- Helpers ---

  private async readJson(filename: string) {
    const content = await fs.readFile(path.join(DOCS_DIR, filename), "utf-8");
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
