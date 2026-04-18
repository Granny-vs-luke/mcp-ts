---
title: "Introduction"
description: "mcp-ts is a lightweight Model Context Protocol (MCP) client library for JavaScript applications."
icon: "hand-wave"
---

<div className="relative isolate overflow-hidden">
  <div className="absolute inset-x-0 top-0 -z-10 h-[600px] w-full bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-red-500/10 via-transparent to-transparent"></div>
  
  <div className="max-w-5xl mx-auto px-6 pt-8 pb-8 text-center">
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        ```mermaid
        graph LR
            subgraph Direct["Direct SDK Flow (SSE)"]
                UI[Browser UI]
                Hook[useMcp Hook]
                API[Next.js /api/mcp]
                Mgr[MultiSessionClient]
                Store[(Redis/File/Memory)]
                MCP[MCP Servers]

                UI <--> Hook
                Hook -- "HTTP RPC" --> API
                API --> Mgr
                Mgr -- "SSE events" --> Hook
                Mgr <--> Store
                Mgr <--> MCP
            end

            subgraph Bridge["Remote Bridge Flow (mcp-local-agent)"]
                direction TB
                Spacer[" "]
                Agent[Local Agent Runtime]
                Remote[Remote Bridge Server]
                LocalMcp[Local MCP Servers]

                Spacer --- Agent
                Agent -- "WSS /connect (outbound)" --> Remote
                Agent <--> LocalMcp
                style Spacer fill:transparent,stroke:transparent,color:transparent
            end
        ```
      </div>
    </div>
  </div>
</div>

<div className="max-w-5xl mx-auto px-6 pt-12 pb-24">
  <h2 className="text-3xl font-bold mb-8 text-gray-800 dark:text-gray-100">Showcases</h2>
  
  <div className="flex flex-col gap-12 mb-16">
    <div className="space-y-4">
      <h3 className="text-xl font-bold text-gray-700 dark:text-gray-300">General Overview</h3>
      <p className="text-gray-600 dark:text-gray-400">
        A walkthrough of the core SDK capabilities, including server connection, basic tool discovery, and execution.
      </p>
      <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 shadow-lg">
        <video controls className="w-full aspect-video" src="/videos/mcp-ts.mp4"></video>
      </div>
    </div>
    <div className="space-y-4">
      <h3 className="text-xl font-bold text-gray-700 dark:text-gray-300">Interactive MCP Apps</h3>
      <p className="text-gray-600 dark:text-gray-400">
        Learn how to render and interact with complex UI components served directly from MCP servers using our secure, isolated sandbox bridge.
      </p>
      <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 shadow-lg">
        <video controls className="w-full aspect-video" src="/videos/mcp-apps-ext.mp4"></video>
      </div>
    </div>
    <div className="space-y-4">
      <h3 className="text-xl font-bold text-gray-700 dark:text-gray-300">LangChain AI Integration</h3>
      <p className="text-gray-600 dark:text-gray-400">
        A demonstration of how to seamlessly integrate MCP tools into a LangChain agent workflow using the mcp-ts AI adapter.
      </p>
      <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 shadow-lg">
        <video controls className="w-full aspect-video" src="/videos/langchain-agui.mp4"></video>
      </div>
    </div>
  </div>

  <h2 className="text-3xl font-bold mb-8 text-gray-800 dark:text-gray-100">Core Capabilities</h2>

  <CardGroup cols={2}>
    <Card title="SDK Client" icon="code">
      Type-safe methods for connecting to servers, listing tools, and executing prompts with real-time updates.
    </Card>
    <Card title="Framework Support" icon="layer-group">
      First-class hooks and adapters for Next.js, React, and Vue to seamlessly integrate MCP.
    </Card>
    <Card title="Session Persistence" icon="database">
      Automatic recovery with support for Redis, Supabase, and local File System backends.
    </Card>
    <Card title="Interactive MCP Apps" icon="browser">
      Render complex UI components from MCP servers using a secure, isolated sandbox.
    </Card>
  </CardGroup>

  <div className="py-12">
    <h2 className="text-3xl font-bold mb-8 text-gray-800 dark:text-gray-100">Setup in 3 Steps</h2>
    <Steps>
      <Step title="Installation">
        Add the SDK to your project.
        ```bash
        npm install @mcp-ts/sdk
        ```
      </Step>
      <Step title="Server Handler">
        Configure the SSE handler in your choice of backend.
        ```typescript
        import { createSSEHandler } from '@mcp-ts/sdk/server';
        ```
      </Step>
      <Step title="Client Connection">
        Connect and start calling tools.
        ```typescript
        const { status } = useMcp({ url: '/api/mcp' });
        ```
      </Step>
    </Steps>
  </div>
</div>
