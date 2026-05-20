import { UIMessage, createAgentUIStreamResponse } from "ai";
import { createMcpAgent } from "../../agent/agent";

export const maxDuration = 60; // Max serverless function duration

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const agent = await createMcpAgent(process.env.NEXT_PUBLIC_MCP_USER_ID!);

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
  });
}
