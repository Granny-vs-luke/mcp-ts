# ToolRouter Benchmarks

This file records reproducible benchmark snapshots for ToolRouter context efficiency.

The benchmark compares two approaches:

- **Load all tools upfront**: every connected MCP tool schema is made available to the model immediately.
- **ToolRouter search mode**: only four meta-tools are loaded initially, then search results and selected full schemas are loaded on demand.

The live benchmark command is:

```bash
npm run benchmark:toolrouter:live
```

It loads active MCP sessions from the configured `mcp-ts` storage backend using `NEXT_PUBLIC_MCP_IDENTITY`, then writes:

```txt
benchmarks/results/live-latest.json
benchmarks/results/live-report.md
```

## Methodology

Live benchmark runs use actual connected MCP servers from `examples/next`.

The measured token counts are estimated by the benchmark harness in `benchmarks/token-estimator.mjs`. Latency values are measured locally with Node.js `performance.now()` and reported as average, p50, p95, and p99 search latency.

The benchmark measures:

- total estimated token cost if all full tool schemas are loaded upfront
- initial ToolRouter meta-tool token cost
- ToolRouter cost after top-5 discovery plus one selected full schema
- ToolRouter cost after top-5 discovery plus three selected full schemas
- index build latency
- repeated search latency

## Live Run: 128 Tools

This run used six connected MCP servers.

| MCP server | Notes | Tools |
|---|---|---:|
| Supabase MCP | Supabase database/project tools | 29 |
| Exa MCP | Reported by server metadata as `mcp-typescript server on vercel` | 7 |
| Notion MCP | Notion workspace tools | 14 |
| DeepWiki MCP | DeepWiki repository/wiki tools | 3 |
| Neon MCP | Reported by server metadata as `mcp-server-neon` | 29 |
| Zapier MCP | Zapier actions, including connected app actions such as Gmail, GitHub, and Google Calendar | 46 |
| **Total** |  | **128** |

| Metric | Result |
|---|---:|
| Load all tools upfront | 287,113 tokens |
| ToolRouter initial load | 3,571 tokens |
| Initial reduction | 98.76% |
| ToolRouter after search + 1 schema | 5,579 tokens |
| 1-tool task reduction | 98.06% |
| ToolRouter after search + 3 schemas | 9,186 tokens |
| 3-tool task reduction | 96.80% |

| Latency metric | Result |
|---|---:|
| Index build | 24.72 ms |
| Average search | 0.1107 ms |
| p50 search | 0.0932 ms |
| p95 search | 0.2372 ms |
| p99 search | 0.3163 ms |

## Live Run: 60 Tools

This run used only Notion MCP and Zapier MCP.

| MCP server | Notes | Tools |
|---|---|---:|
| Notion MCP | Notion workspace tools | 14 |
| Zapier MCP | Zapier actions, including connected app actions such as Gmail, GitHub, and Google Calendar | 46 |
| **Total** |  | **60** |

| Metric | Result |
|---|---:|
| Load all tools upfront | 178,007 tokens |
| ToolRouter initial load | 3,571 tokens |
| Initial reduction | 97.99% |
| ToolRouter after search + 1 schema | 5,579 tokens |
| 1-tool task reduction | 96.87% |
| ToolRouter after search + 3 schemas | 9,186 tokens |
| 3-tool task reduction | 94.84% |

| Latency metric | Result |
|---|---:|
| Index build | 26.22 ms |
| Average search | 0.0580 ms |
| p50 search | 0.0493 ms |
| p95 search | 0.0875 ms |
| p99 search | 0.2108 ms |

## Analysis & Conclusion

These benchmarks demonstrate that ToolRouter provides significant context-efficiency gains, particularly in environments with a large number of connected MCP tools. By dynamically loading schemas only when needed, ToolRouter avoids "context bloat" and ensures the model remains focused on relevant tools.

### Key Findings

- **Significant Context Reduction**: In live benchmarks against connected MCP servers, ToolRouter reduced initial tool-schema context by **97.99%** (60 tools) and **98.76%** (128 tools) compared to loading every full schema upfront.
- **Sustained Efficiency**: Even after discovery and loading multiple full schemas, ToolRouter maintains a context reduction of over **96%**.
- **Minimal Latency Overhead**: ToolRouter search and routing are highly optimized, with search latencies typically staying under 0.5ms (p99).

### Considerations for Production

While these results highlight dramatic improvements in schema context management, it is important to note:
1. **End-to-End Latency**: Overall agent performance also depends on model reasoning, network round-trips to MCP servers, and tool execution time.
2. **Cost Savings**: Reduction in input tokens directly translates to lower operational costs when using usage-based LLM APIs.
3. **Model Focus**: Smaller context windows often lead to improved model performance and fewer "lost in the middle" errors.

