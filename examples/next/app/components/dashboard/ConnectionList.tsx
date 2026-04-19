"use client";

import { ServerIcon } from "lucide-react";
import ConnectionItem from "./ConnectionItem";
import type { Connection } from "./types";

interface ConnectionListProps {
  connections: Connection[];
  isInitializing: boolean;
  onDisconnect: (sessionId: string) => void;
  onSelectTool: (sessionId: string, toolName: string) => void;
}

export default function ConnectionList({
  connections,
  isInitializing,
  onDisconnect,
  onSelectTool,
}: ConnectionListProps) {
  return (
    <section className="rounded-xl border border-border/80 bg-card/50 p-4 shadow-sm ring-1 ring-foreground/5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Sessions
        </h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {connections.length}
        </span>
      </div>

      {isInitializing ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
          Loading sessions…
        </p>
      ) : null}

      {!isInitializing && connections.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-8 text-center">
          <ServerIcon className="size-8 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">
            No connections yet. Add a server above.
          </p>
        </div>
      ) : null}

      <ul className="mt-2 flex flex-col gap-2">
        {connections.map((connection) => (
          <li key={connection.sessionId}>
            <ConnectionItem
              connection={connection}
              onDisconnect={onDisconnect}
              onSelectTool={onSelectTool}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
