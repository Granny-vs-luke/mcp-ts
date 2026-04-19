"use client";

import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { Connection } from "./types";

interface ConnectionItemProps {
  connection: Connection;
  onDisconnect: (sessionId: string) => void;
  onSelectTool: (sessionId: string, toolName: string) => void;
}

function stateBadgeClass(state: string) {
  switch (state) {
    case "CONNECTED":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "CONNECTING":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "AUTHENTICATING":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
    case "FAILED":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export default function ConnectionItem({
  connection,
  onDisconnect,
  onSelectTool,
}: ConnectionItemProps) {
  const sessionIdStr = String(connection.sessionId);

  return (
    <div className="rounded-lg border border-border/80 bg-background/80 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {connection.serverName}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {sessionIdStr.slice(0, 8)}…
            </code>
            <span
              className={cn(
                "inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                stateBadgeClass(connection.state),
              )}
            >
              {connection.state}
            </span>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => onDisconnect(sessionIdStr)}
        >
          Disconnect
        </Button>
      </div>

      {connection.error ? (
        <p className="mt-2 rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {connection.error}
        </p>
      ) : null}

      {connection.tools && connection.tools.length > 0 ? (
        <Collapsible className="mt-3">
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted [&[data-state=open]>svg]:rotate-180">
            <span>Tools ({connection.tools.length})</span>
            <ChevronDownIcon className="size-4 shrink-0 transition-transform duration-200" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-1.5">
            {connection.tools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 p-2"
              >
                <div className="min-w-0 flex-1">
                  <code className="text-xs font-semibold text-foreground">
                    {tool.name}
                  </code>
                  {tool.description ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {tool.description}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => onSelectTool(sessionIdStr, tool.name)}
                >
                  Run
                </Button>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <Collapsible className="mt-2">
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
          <span>Details</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70 transition-transform duration-200" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1.5 rounded-md bg-muted/30 p-2 text-[11px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Server</dt>
            <dd className="break-all font-mono text-foreground">
              {connection.serverId}
            </dd>
            <dt className="text-muted-foreground">URL</dt>
            <dd className="break-all text-foreground">{connection.serverUrl}</dd>
            <dt className="text-muted-foreground">Session</dt>
            <dd className="break-all font-mono text-foreground">
              {sessionIdStr}
            </dd>
            <dt className="text-muted-foreground">Transport</dt>
            <dd className="text-foreground">
              {connection.transport || "sse"}
            </dd>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
