"use client";

import { useEffect, useMemo, useState } from "react";
import type { CustomEvent } from "@ag-ui/client";
import { useAgent } from "@copilotkitnext/react";

import { useMcpContext } from "./mcp-provider";

type JsonSchemaProperty = {
  type?: string;
  title?: string;
  enum?: string[];
  enumNames?: string[];
  minimum?: number;
  maximum?: number;
};

type ElicitationPayload = {
  _mcp_elicitation: true;
  elicitationId: string;
  mode?: "form" | "url";
  message?: string;
  requestedSchema?: {
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  url?: string;
};

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isElicitationPayload(value: unknown): value is ElicitationPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "_mcp_elicitation" in value &&
    (value as any)._mcp_elicitation === true &&
    typeof (value as any).elicitationId === "string"
  );
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function McpElicitationUI({ agentId = "mcpAssistant" }: { agentId?: string }) {
  const { mcpClient } = useMcpContext();
  const { agent } = useAgent({ agentId });

  const [elicitation, setElicitation] = useState<ElicitationPayload | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!agent) return;

    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        // CopilotKit sometimes sends custom event values as strings.
        const raw = parseMaybeJson((event as CustomEvent).value);
        if (!isElicitationPayload(raw)) return;
        setFormData({});
        setElicitation(raw);
      },
      onRunStartedEvent: () => {
        // If a run restarts while we're showing a form, keep it open. The tool is still pending.
      },
    });

    return () => subscription.unsubscribe();
  }, [agent]);

  const schema = elicitation?.requestedSchema ?? {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const mode = elicitation?.mode ?? "form";

  const missingRequired = useMemo(() => {
    if (mode !== "form") return [];
    return required.filter((key) => formData[key] == null || formData[key] === "");
  }, [mode, required, formData]);

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

  const respond = async (action: "accept" | "decline" | "cancel") => {
    if (!elicitation) return;
    setSubmitting(true);
    try {
      await mcpClient.respondToElicitation(
        elicitation.elicitationId,
        action,
        action === "accept" ? formData : undefined
      );
      setElicitation(null);
      setFormData({});
    } finally {
      setSubmitting(false);
    }
  };

  if (!elicitation) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={() => void respond("cancel")}
        disabled={submitting}
      />

      <div className="relative mx-4 w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Information Requested</div>
            {elicitation.message ? (
              <div className="mt-1 whitespace-pre-wrap text-sm text-zinc-300">
                {elicitation.message}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50 disabled:opacity-50"
            onClick={() => void respond("cancel")}
            disabled={submitting}
          >
            X
          </button>
        </div>

        <div className="px-4 py-4">
          {mode === "url" ? (
            <div className="space-y-3">
              <div className="text-sm text-zinc-300">
                This tool needs you to complete an authorization flow.
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
                  onClick={() => {
                    if (elicitation.url) window.open(elicitation.url, "_blank", "noopener,noreferrer");
                    void respond("accept");
                  }}
                  disabled={submitting}
                >
                  Authorize
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
                  onClick={() => void respond("decline")}
                  disabled={submitting}
                >
                  Decline
                </button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (missingRequired.length > 0) return;
                void respond("accept");
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
                        className="size-4 rounded border-zinc-700 bg-zinc-900"
                        checked={Boolean(formData[key])}
                        disabled={submitting}
                        onChange={(e) => updateField(key, e.target.checked)}
                      />
                      <span className="text-zinc-200">
                        {label}
                        {requiredMark}
                      </span>
                    </label>
                  );
                }

                if (Array.isArray(prop.enum)) {
                  return (
                    <div key={key} className="grid gap-1.5">
                      <label className="text-xs font-medium text-zinc-400">
                        {label}
                        {requiredMark}
                      </label>
                      <select
                        className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-zinc-400"
                        value={String(formData[key] ?? "")}
                        disabled={submitting}
                        onChange={(e) => updateField(key, e.target.value)}
                      >
                        <option value="" disabled>
                          Select…
                        </option>
                        {prop.enum.map((option, idx) => (
                          <option key={option} value={option}>
                            {prop.enumNames?.[idx] ?? option}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }

                const isNumber = prop.type === "number";
                return (
                  <div key={key} className="grid gap-1.5">
                    <label className="text-xs font-medium text-zinc-400">
                      {label}
                      {requiredMark}
                    </label>
                    <input
                      className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-zinc-400"
                      type={isNumber ? "number" : "text"}
                      min={prop.minimum}
                      max={prop.maximum}
                      value={String(formData[key] ?? "")}
                      disabled={submitting}
                      onChange={(e) =>
                        updateField(
                          key,
                          isNumber && e.target.value !== "" ? Number(e.target.value) : e.target.value
                        )
                      }
                    />
                  </div>
                );
              })}

              {missingRequired.length > 0 ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Fill required fields: {missingRequired.join(", ")}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  className={classNames(
                    "rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50",
                    missingRequired.length > 0 && "opacity-50"
                  )}
                  disabled={submitting || missingRequired.length > 0}
                >
                  Submit
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
                  onClick={() => void respond("decline")}
                  disabled={submitting}
                >
                  Decline
                </button>
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50 disabled:opacity-50"
                  onClick={() => void respond("cancel")}
                  disabled={submitting}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

