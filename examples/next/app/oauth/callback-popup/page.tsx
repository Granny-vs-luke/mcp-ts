"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

const AUTH_CODE_MESSAGE = "MCP_AUTH_CODE";
const AUTH_RESULT_MESSAGE = "MCP_AUTH_RESULT";

function PopupCallbackContent() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code");
  const sessionId = searchParams.get("state");

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  const openerMissing = typeof window !== "undefined" ? !window.opener : false;
  const missingCode = !code;
  const missingSessionId = !sessionId;
  const blockingError = openerMissing
    ? "No opener window found. This window should be opened from the app."
    : missingCode
    ? "No authorization code received."
    : missingSessionId
    ? "No OAuth state received."
    : null;

  useEffect(() => {
    if (blockingError) {
      setStatus("error");
      setErrorMessage(blockingError);
      return;
    }

    let closed = false;

    const handleResult = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== AUTH_RESULT_MESSAGE) return;
      if (event.data.sessionId !== sessionId) return;

      if (event.data.success) {
        setStatus("success");
        window.removeEventListener("message", handleResult);
        closed = true;
        window.setTimeout(() => window.close(), 1200);
        return;
      }

      setStatus("error");
      setErrorMessage(
        typeof event.data.error === "string" && event.data.error.length > 0
          ? event.data.error
          : "Failed to complete authorization."
      );
    };

    window.addEventListener("message", handleResult);

    try {
      window.opener.postMessage(
        { type: AUTH_CODE_MESSAGE, code, sessionId },
        window.location.origin
      );
    } catch {
      window.setTimeout(() => {
        setStatus("error");
        setErrorMessage("Could not communicate with main window. Please close this window and try again.");
      }, 0);
    }

    return () => {
      if (!closed) {
        window.removeEventListener("message", handleResult);
      }
    };
  }, [blockingError, code, sessionId]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50/50 text-gray-900 font-sans p-4">
      <div className="p-8 bg-white shadow-xl shadow-black/5 rounded-2xl flex flex-col items-center justify-center max-w-sm w-full border border-gray-100 text-center transition-all duration-300">
        <div className="mb-6 flex items-center justify-center h-16">
          {status === "loading" && (
            <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
          )}
          {status === "success" && (
            <CheckCircle2 className="w-14 h-14 text-emerald-500" />
          )}
          {status === "error" && (
            <XCircle className="w-14 h-14 text-red-500" />
          )}
        </div>
        
        <h2 className="text-xl font-semibold text-gray-800 mb-2">
          {status === "loading" && "Authenticating..."}
          {status === "success" && "Successfully Connected!"}
          {status === "error" && "Authentication Failed"}
        </h2>
        
        <p className="text-sm text-gray-500 max-w-[260px] leading-relaxed">
          {status === "loading" && "Please wait while we securely connect your workspace."}
          {status === "success" && "Your workspace is now connected in the main window. This window will close automatically."}
          {status === "error" && errorMessage}
        </p>

        {status === "error" && (
          <button 
            onClick={() => window.close()}
            className="mt-8 px-5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-xl text-sm font-medium transition-colors"
          >
            Close Window
          </button>
        )}
      </div>
    </div>
  );
}

export default function PopupCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-gray-50/50">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
        </div>
      }
    >
      <PopupCallbackContent />
    </Suspense>
  );
}
