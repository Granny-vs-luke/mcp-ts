"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { ShieldAlert } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { RiRobot2Line } from "react-icons/ri";
import { McpAppRenderer, getMcpAppMetadata, type McpClient } from "@mcp-ts/sdk/client/react";

/** True once the latest assistant turn has something to render (text or tool UI). */
function assistantShowsProgress(m: UIMessage | undefined): boolean {
  if (!m || m.role !== "assistant") return false;
  const parts = m.parts ?? [];
  for (const p of parts) {
    if (p.type === "text") {
      if (String((p as { text?: string }).text ?? "").trim().length > 0) {
        return true;
      }
    } else if (isToolUIPart(p)) {
      return true;
    }
  }
  return false;
}

interface HomeChatProps {
  className?: string;
  mcpClient?: McpClient | null;
}

export default function HomeChat({
  className,
  mcpClient,
}: HomeChatProps) {
  const { error, status, sendMessage, messages, regenerate, stop, addToolApprovalResponse } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const isGenerating = status === "submitted" || status === "streaming";
  const last = messages[messages.length - 1];
  const showThinking = isGenerating && !assistantShowsProgress(last);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<RiRobot2Line className="size-10 opacity-50" />}
              title="Chat"
              description="Connect MCP servers in the sidebar, then ask anything. Tool calls appear inline."
            />
          ) : null}

          {messages.map((m) => (
            <Message key={m.id} from={m.role}>
              <MessageContent>
                {m.parts?.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <MessageResponse key={index}>{part.text}</MessageResponse>
                    );
                  }

                  if (part.type === "step-start") {
                    return index > 0 ? (
                      <div
                        key={index}
                        className="my-2 border-t border-border"
                      />
                    ) : null;
                  }

                  if (isToolUIPart(part)) {
                    const toolPart = part as ToolUIPart | DynamicToolUIPart;
                    const frameToolName = getToolName(toolPart);
                    const title = toolPart.title || frameToolName;
                    const input = toolPart.input as Record<string, unknown> | null | undefined;

                    // The SDK handles unwrapping `mcp_execute_tool` internally
                    const metadata = getMcpAppMetadata(mcpClient || null, frameToolName, input);
                    const hasApp = !!metadata;

                    // If getMcpAppMetadata found an app, it unwrapped it. We can still render the raw frames
                    // since McpAppRenderer also unwraps internally.
                    const resolvedToolName = metadata ? metadata.toolName : frameToolName;

                    const appStatus =
                      toolPart.state === "input-streaming" || toolPart.state === "input-available"
                        ? "executing"
                        : toolPart.state === "output-available"
                        ? "complete"
                        : "idle";

                    const elicitationData = (() => {
                      if (!toolPart.output || typeof toolPart.output !== 'object') return null;
                      const output = toolPart.output as any;
                      if (!output.isError || !Array.isArray(output.content)) return null;
                      const textPart = output.content.find((c: any) => c.type === 'text');
                      if (!textPart || typeof textPart.text !== 'string') return null;
                      try {
                        const parsed = JSON.parse(textPart.text);
                        return parsed._mcp_elicitation ? parsed : null;
                      } catch {
                        return null;
                      }
                    })();

                    if (elicitationData) {
                      return (
                        <div key={index} className="my-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <ShieldAlert className="size-4 text-blue-500" />
                            <span className="font-medium text-sm text-blue-700 dark:text-blue-400">Information Requested</span>
                          </div>
                          <p className="text-sm font-medium mb-1">{elicitationData.message}</p>
                          {elicitationData.requestedSchema?.properties && (
                            <div className="mt-2 space-y-1">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Requested Fields:</p>
                              <div className="flex flex-wrap gap-1">
                                {Object.keys(elicitationData.requestedSchema.properties).map(prop => (
                                  <span key={prop} className="text-[10px] bg-blue-500/10 text-blue-700 dark:text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20">
                                    {prop}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-3 italic">
                            Please provide these details in the chat below.
                          </p>
                        </div>
                      );
                    }

                    if (toolPart.state === "approval-requested") {
                      return (
                        <div key={index} className="my-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <ShieldAlert className="size-4 text-amber-500" />
                            <span className="font-medium text-sm text-amber-700 dark:text-amber-400">Tool Approval Required</span>
                          </div>
                          <p className="text-sm text-muted-foreground mb-3">
                            The agent wants to execute <code className="bg-amber-500/10 px-1 rounded text-amber-700 dark:text-amber-400">{resolvedToolName}</code>
                          </p>
                          {input && Object.keys(input).length > 0 && (
                            <pre className="text-[10px] bg-muted/50 p-2 rounded mb-4 overflow-auto max-h-32 border border-border/50">
                              {JSON.stringify(input, null, 2)}
                            </pre>
                          )}
                          <div className="flex gap-2">
                            <Button 
                              size="sm" 
                              className="bg-amber-600 hover:bg-amber-700 text-white border-0"
                              onClick={() => {
                                if ('approval' in toolPart && toolPart.approval) {
                                  addToolApprovalResponse({
                                    id: (toolPart.approval as any).id,
                                    approved: true,
                                  });
                                }
                              }}
                            >
                              Approve
                            </Button>
                            <Button 
                              size="sm" 
                              variant="outline"
                              className="border-amber-200 dark:border-amber-900 hover:bg-amber-100 dark:hover:bg-amber-950"
                              onClick={() => {
                                if ('approval' in toolPart && toolPart.approval) {
                                  addToolApprovalResponse({
                                    id: (toolPart.approval as any).id,
                                    approved: false,
                                  });
                                }
                              }}
                            >
                              Deny
                            </Button>
                          </div>
                        </div>
                      );
                    }



                    if (toolPart.type === "dynamic-tool") {
                      return (
                        <div key={index} className="space-y-3">
                          <Tool>
                            <ToolHeader
                              type="dynamic-tool"
                              state={toolPart.state}
                              toolName={frameToolName}
                              title={title}
                            />
                            <ToolContent>
                              {input != null ? (
                                <ToolInput input={input} />
                              ) : null}
                              <ToolOutput
                                errorText={toolPart.errorText}
                                output={toolPart.output}
                              />
                            </ToolContent>
                          </Tool>

                          {hasApp && resolvedToolName ? (
                            /* ── Inline MCP App iframe ── */
                            <McpAppRenderer
                              client={mcpClient}
                              name={frameToolName}
                              sandbox={{ url: "/sandbox_proxy.html" }}
                              input={input}
                              result={toolPart.output}
                              status={appStatus}
                              className="min-h-[420px] w-full"
                              loader={
                                <div className="flex flex-col items-center gap-2 py-8">
                                  <Spinner className="size-6 text-primary" />
                                  <span className="text-xs text-muted-foreground">
                                    Loading interactive app…
                                  </span>
                                </div>
                              }
                            />
                          ) : null}
                        </div>
                      );
                    }



                    return (
                      <div key={index} className="space-y-3">
                        <Tool>
                          <ToolHeader
                            type={toolPart.type}
                            state={toolPart.state}
                            title={title}
                          />
                          <ToolContent>
                            {input != null ? (
                              <ToolInput input={input} />
                            ) : null}
                            <ToolOutput
                              errorText={toolPart.errorText}
                              output={toolPart.output}
                            />
                          </ToolContent>
                        </Tool>
                        
                        {hasApp && resolvedToolName ? (
                          /* ── Inline MCP App iframe ── */
                          <McpAppRenderer
                            client={mcpClient}
                            name={frameToolName}
                            sandbox={{ url: "/sandbox_proxy.html" }}
                            input={input}
                            result={toolPart.output}
                            status={appStatus}
                            className="min-h-[420px] w-full"
                            loader={
                              <div className="flex flex-col items-center gap-2 py-8">
                                <Spinner className="size-6 text-primary" />
                                <span className="text-xs text-muted-foreground">
                                  Loading interactive app…
                                </span>
                              </div>
                            }
                          />
                        ) : null}
                      </div>
                    );
                  }

                  return null;
                })}
              </MessageContent>
            </Message>
          ))}

          {showThinking ? (
            <Message from="assistant">
              <MessageContent className="flex flex-row flex-wrap items-center gap-3">
                <Spinner className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground text-sm">
                  {status === "submitted"
                    ? "Thinking…"
                    : "Responding…"}
                </span>
              </MessageContent>
            </Message>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <p className="font-medium text-destructive">{error.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => regenerate()}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 border-t border-border bg-background py-3">
        <PromptInput
          onSubmit={({ text, files }) => {
            const parts: Array<
              | { type: "text"; text: string }
              | { type: "file"; mediaType: string; url: string }
            > = [];

            const trimmed = text.trim();
            if (trimmed) {
              parts.push({ type: "text", text: trimmed });
            }

            for (const f of files) {
              parts.push({
                type: "file",
                mediaType: f.mediaType,
                url: f.url,
              });
            }

            if (!parts.length) {
              return;
            }

            void sendMessage({ parts } as never);
          }}
        >
          <PromptInputTextarea placeholder="Message the assistant…" />
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger tooltip="Add attachments" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
      </div>
    </div>
  );
}
