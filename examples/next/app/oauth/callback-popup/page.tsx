"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function PopupCallbackContent() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const [status, setStatus] = useState("Authorization received. Finishing sign-in...");
  const openerMissing =
    typeof window !== "undefined" ? !window.opener : false;
  const missingCode = !code;
  const missingState = !state;
  const blockingStatus = openerMissing
    ? "Error: No opener window found. This window should be opened from the app."
    : missingCode
      ? "Error: No authorization code received."
      : missingState
        ? "Error: No OAuth state received."
        : null;

  useEffect(() => {
    if (blockingStatus) {
      return;
    }

    let closed = false;

    const handleResult = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data?.type !== "MCP_AUTH_RESULT") {
        return;
      }

      if (event.data.sessionId !== state) {
        return;
      }

      if (event.data.success) {
        setStatus("Authorization complete. Closing window...");
        window.removeEventListener("message", handleResult);
        closed = true;
        setTimeout(() => {
          window.close();
        }, 700);
        return;
      }

      const message =
        typeof event.data.error === "string" && event.data.error.length > 0
          ? event.data.error
          : "Failed to complete authorization.";
      setStatus(`Authorization failed: ${message}`);
    };

    window.addEventListener("message", handleResult);

    try {
      window.opener.postMessage(
        { type: "MCP_AUTH_CODE", code, sessionId: state },
        window.location.origin,
      );
    } catch (err) {
      console.error("Failed to communicate with opener:", err);
      window.setTimeout(() => {
        setStatus("Error: Could not communicate with main window.");
      }, 0);
    }

    return () => {
      if (!closed) {
        window.removeEventListener("message", handleResult);
      }
    };
  }, [blockingStatus, code, state]);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        flexDirection: "column",
        gap: "1rem",
        backgroundColor: "#f5f5f5",
        color: "#333",
      }}
    >
      <div
        style={{
          padding: "2rem",
          borderRadius: "8px",
          backgroundColor: "white",
          boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          textAlign: "center",
        }}
      >
        <h2>MCP Authentication</h2>
        <p>{blockingStatus ?? status}</p>
      </div>
    </div>
  );
}

export default function PopupCallbackPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PopupCallbackContent />
    </Suspense>
  );
}
