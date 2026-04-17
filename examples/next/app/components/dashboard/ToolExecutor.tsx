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
}

export default function ToolExecutor({
  selectedTool,
  onClose,
  onExecute,
  isExecuting,
  toolResult: externalToolResult,
}: ToolExecutorProps) {
  const [toolArgs, setToolArgs] = useState("{}");

  useEffect(() => {
    if (selectedTool) {
      setToolArgs("{}");
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
            ) : null}

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
