---
title: "FAQ"
description: "Frequently asked questions about mcp-ts."
icon: "question"
---

Have a question about mcp-ts? Check out these common questions below.

<AccordionGroup>
  <Accordion title="What is the Model Context Protocol (MCP)?">
    The Model Context Protocol (MCP) is an open standard that allows developers to build secure, two-way connections between updated data sources and AI models.
  </Accordion>

  <Accordion title="How do I handle authentication?">
    mcp-ts supports multiple authentication patterns, including OAuth 2.0. You can use the `finishAuth` method on the client side to complete OAuth flows initiated by MCP servers.
  </Accordion>

  <Accordion title="Which storage backend should I use?">
    - **Redis**: Best for production and distributed environments (serverless).
    - **File System**: Great for local development with persistence.
    - **In-Memory**: Ideal for testing and ephemeral sessions.
    - **Supabase**: Perfect for cloud-native applications already using Supabase.
  </Accordion>

  <Accordion title="Does mcp-ts work with the Vercel AI SDK?">
    Yes! We provide a first-class `AIAdapter` that transforms MCP tools into a format compatible with the Vercel AI SDK's `tools` property.
  </Accordion>
  
  <Accordion title="Can I use mcp-ts on the client side only?">
    mcp-ts requires a server-side handler to bridge the SSE connection and manage persistent session data securely. However, the `useMcp` hook makes it feel like a client-only experience.
  </Accordion>
</AccordionGroup>

<Tip>
  If you have a question not answered here, feel free to open a discussion on our [GitHub repository](https://github.com/zonlabs/mcp-ts/discussions).
</Tip>
