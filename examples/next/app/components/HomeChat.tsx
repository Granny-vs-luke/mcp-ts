"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

type ElicitationData = {
  _mcp_elicitation: true;
  mode?: "form" | "url";
  message?: string;
  requestedSchema?: {
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  url?: string;
};

type JsonSchemaProperty = {
  type?: string;
  title?: string;
  enum?: string[];
  enumNames?: string[];
  minimum?: number;
  maximum?: number;
};

type ToolTextOutput = {
  isError?: boolean;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

function isElicitationData(value: unknown): value is ElicitationData {
  return (
    typeof value === "object" &&
    value !== null &&
    "_mcp_elicitation" in value &&
    (value as { _mcp_elicitation?: unknown })._mcp_elicitation === true
  );
}

function ElicitationFormCard({
  data,
  onSubmit,
}: {
  data: ElicitationData;
  onSubmit: (message: string) => void;
}) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [submitted, setSubmitted] = useState(false);

  const schema = data.requestedSchema ?? {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const mode = data.mode ?? "form";

  const updateField = (key: string, value: unknown) => {
    setFormData((prev) => {
      const next = { ...prev };
      if (value === "" || value == null) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const submit = (action: "accept" | "decline" | "cancel") => {
    const payload =
      action === "accept"
        ? `Elicitation response accepted for "${data.message ?? "MCP request"}":\n${JSON.stringify(formData, null, 2)}`
        : `Elicitation response ${action}ed for "${data.message ?? "MCP request"}".`;
    setSubmitted(true);
    onSubmit(payload);
  };

  return (
    <div className="my-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert className="size-4 text-blue-500" />
        <span className="font-medium text-sm text-blue-700 dark:text-blue-400">
          Information Requested
        </span>
      </div>
      {data.message ? (
        <p className="mb-3 text-sm font-medium">{data.message}</p>
      ) : null}

      {mode === "url" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={submitted}
            onClick={() => {
              if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
              submit("accept");
            }}
          >
            Authorize
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={submitted}
            onClick={() => submit("decline")}
          >
            Decline
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit("accept");
          }}
        >
          {Object.entries(properties).map(([key, prop]) => {
            const label = prop.title || key;
            const requiredMark = required.includes(key) ? " *" : "";

            if (prop.type === "boolean") {
              return (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-border"
                    checked={Boolean(formData[key])}
                    disabled={submitted}
                    onChange={(event) => updateField(key, event.target.checked)}
                  />
                  <span>
                    {label}
                    {requiredMark}
                  </span>
                </label>
              );
            }

            if (Array.isArray(prop.enum)) {
              return (
                <div key={key} className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {label}
                    {requiredMark}
                  </label>
                  <Select
                    value={String(formData[key] ?? "")}
                    disabled={submitted}
                    onValueChange={(value) => updateField(key, value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {prop.enum.map((option, optionIndex) => (
                        <SelectItem key={option} value={option}>
                          {prop.enumNames?.[optionIndex] ?? option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }

            return (
              <div key={key} className="grid gap-1.5">
                <label htmlFor={`elicitation-${key}`} className="text-xs font-medium text-muted-foreground">
                  {label}
                  {requiredMark}
                </label>
                <Input
                  id={`elicitation-${key}`}
                  type={prop.type === "number" ? "number" : "text"}
                  min={prop.minimum}
                  max={prop.maximum}
                  value={String(formData[key] ?? "")}
                  disabled={submitted}
                  onChange={(event) =>
                    updateField(
                      key,
                      prop.type === "number" && event.target.value !== ""
                        ? Number(event.target.value)
                        : event.target.value
                    )
                  }
                />
              </div>
            );
          })}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" type="submit" disabled={submitted}>
              Submit
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={submitted}
              onClick={() => submit("decline")}
            >
              Decline
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={submitted}
              onClick={() => submit("cancel")}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
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
                      const output = toolPart.output as ToolTextOutput;
                      if (!output.isError || !Array.isArray(output.content)) return null;
                      const textPart = output.content.find((c) => c.type === 'text');
                      if (!textPart || typeof textPart.text !== 'string') return null;
                      console.log("[MCP-ElicitDebug][HomeChat] inspecting tool output", {
                        toolName: frameToolName,
                        text: textPart.text.slice(0, 200),
                      });
                      try {
                        const parsed = JSON.parse(textPart.text);
                        console.log("[MCP-ElicitDebug][HomeChat] parsed tool output", {
                          toolName: frameToolName,
                          isElicitation: isElicitationData(parsed),
                          parsed,
                        });
                        return isElicitationData(parsed) ? parsed : null;
                      } catch (error) {
                        console.log("[MCP-ElicitDebug][HomeChat] failed to parse tool output", {
                          toolName: frameToolName,
                          error: error instanceof Error ? error.message : String(error),
                        });
                        return null;
                      }
                    })();

                    if (elicitationData) {
                      return (
                        <ElicitationFormCard
                          key={index}
                          data={elicitationData}
                          onSubmit={(text) => {
                            void sendMessage({ parts: [{ type: "text", text }] } as never);
                          }}
                        />
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
                                const approval = ("approval" in toolPart ? toolPart.approval : undefined) as { id?: string } | undefined;
                                if (approval?.id) {
                                  addToolApprovalResponse({
                                    id: approval.id,
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
                                const approval = ("approval" in toolPart ? toolPart.approval : undefined) as { id?: string } | undefined;
                                if (approval?.id) {
                                  addToolApprovalResponse({
                                    id: approval.id,
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
