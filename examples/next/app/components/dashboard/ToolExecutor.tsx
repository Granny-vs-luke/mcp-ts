"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Terminal, Monitor } from "lucide-react";

interface ToolExecutorProps {
  selectedTool: {
    sessionId: string;
    toolName: string;
  } | null;
  onClose: () => void;
  onExecute: (
    sessionId: string,
    toolName: string,
    toolArgs: string,
  ) => Promise<unknown>;
  isExecuting: boolean;
  toolResult: unknown;
  McpAppRenderer: React.ComponentType<any>;
}

export default function ToolExecutor({
  selectedTool,
  onClose,
  onExecute,
  isExecuting,
  toolResult: externalToolResult,
  McpAppRenderer,
}: ToolExecutorProps) {
  const [toolArgs, setToolArgs] = useState("{}");
  const [activeTab, setActiveTab] = useState<string>("args");

  useEffect(() => {
    if (selectedTool) {
      setToolArgs("{}");
      setActiveTab("args");
    }
  }, [selectedTool]);

  const handleExecute = () => {
    if (!selectedTool) return;
    void onExecute(selectedTool.sessionId, selectedTool.toolName, toolArgs);
  };

  return (
    <Dialog
      open={!!selectedTool}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[min(90vh,640px)] gap-4 overflow-y-auto sm:max-w-lg"
        showCloseButton
      >
        {selectedTool ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono text-sm">
                {selectedTool.toolName}
              </DialogTitle>
              <DialogDescription>
                Edit JSON arguments and run the tool on this session.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <label
                htmlFor="tool-args"
                className="text-xs font-medium text-muted-foreground"
              >
                Arguments (JSON)
              </label>
              <Textarea
                id="tool-args"
                value={toolArgs}
                onChange={(e) => setToolArgs(e.target.value)}
                placeholder='{"key": "value"}'
                className="min-h-[160px] font-mono text-xs"
                disabled={isExecuting}
              />
            </div>
            <div className="flex w-full flex-col gap-4">
              <div className="flex w-full items-center justify-center p-1 bg-muted/30 rounded-lg border">
                <Button
                  variant={activeTab === "args" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveTab("args")}
                  className="flex-1 gap-2 text-xs h-8"
                >
                  <Terminal className="size-3.5" />
                  JSON Arguments
                </Button>
                <Button
                  variant={activeTab === "app" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveTab("app")}
                  className="flex-1 gap-2 text-xs h-8"
                >
                  <Monitor className="size-3.5" />
                  Interactive App
                </Button>
              </div>
              
              {activeTab === "args" && (
                <div className="space-y-4">
                  {externalToolResult != null ? (
                    <div
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        typeof externalToolResult === "object" &&
                        "error" in externalToolResult
                          ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-border bg-muted/40 text-foreground"
                      }`}
                    >
                      <p className="mb-1 font-medium text-muted-foreground">Result</p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                        {JSON.stringify(externalToolResult, null, 2)}
                      </pre>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-8 text-center">
                      <p className="text-xs text-muted-foreground">
                        Run the tool to see the JSON result here.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "app" && (
                <div className="min-h-[300px] overflow-hidden rounded-lg border bg-muted/20">
                  <McpAppRenderer
                    name={selectedTool.toolName}
                    sandbox={{ 
                      url: new URL("/sandbox_proxy.html", window.location.href) 
                    }}
                    input={(() => {
                      try { return JSON.parse(toolArgs); } catch { return {}; }
                    })()}
                    result={externalToolResult}
                    status={isExecuting ? 'executing' : (externalToolResult ? 'complete' : 'idle')}
                    className="h-[400px]"
                    loader={
                      <div className="flex flex-col items-center gap-2">
                        <Spinner className="size-6 text-primary" />
                        <span className="text-xs text-muted-foreground">Initializing Interactive App...</span>
                      </div>
                    }
                  />
                </div>
              )}
            </div>

            <DialogFooter className="gap-2 border-0 bg-transparent p-0 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isExecuting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleExecute}
                disabled={isExecuting}
                className="gap-2"
              >
                {isExecuting ? (
                  <>
                    <Spinner className="size-3.5" />
                    Running…
                  </>
                ) : (
                  "Run tool"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
