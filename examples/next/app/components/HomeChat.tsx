"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
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

export default function HomeChat({ className }: { className?: string }) {
  const { error, status, sendMessage, messages, regenerate, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const isGenerating = status === "submitted" || status === "streaming";
  const last = messages[messages.length - 1];
  const showThinking = isGenerating && !assistantShowsProgress(last);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 sm:px-6">
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
                    const toolName = getToolName(toolPart);
                    const title = toolPart.title || toolName;

                    if (toolPart.type === "dynamic-tool") {
                      return (
                        <Tool key={index} defaultOpen>
                          <ToolHeader
                            type="dynamic-tool"
                            state={toolPart.state}
                            toolName={toolName}
                            title={title}
                          />
                          <ToolContent>
                            {toolPart.input != null ? (
                              <ToolInput input={toolPart.input} />
                            ) : null}
                            <ToolOutput
                              errorText={toolPart.errorText}
                              output={toolPart.output}
                            />
                          </ToolContent>
                        </Tool>
                      );
                    }

                    return (
                      <Tool key={index} defaultOpen>
                        <ToolHeader
                          type={toolPart.type}
                          state={toolPart.state}
                          title={title}
                        />
                        <ToolContent>
                          {toolPart.input != null ? (
                            <ToolInput input={toolPart.input} />
                          ) : null}
                          <ToolOutput
                            errorText={toolPart.errorText}
                            output={toolPart.output}
                          />
                        </ToolContent>
                      </Tool>
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
