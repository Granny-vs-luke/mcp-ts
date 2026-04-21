'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

function OAuthCallbackContent() {
  const searchParams = useSearchParams();
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const [status, setStatus] = useState('Authorization received. Finishing sign-in...');
  const openerMissing = typeof window !== 'undefined' ? !window.opener : false;
  const missingCode = !code;
  const missingState = !state;
  const blockingStatus = openerMissing
    ? 'Error: No opener window found'
    : missingCode
      ? 'Error: No authorization code received'
      : missingState
        ? 'Error: No OAuth state received'
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

      if (event.data?.type !== 'MCP_AUTH_RESULT') {
        return;
      }

      if (event.data.sessionId !== state) {
        return;
      }

      if (event.data.success) {
        setStatus('Authorization complete. Closing...');
        window.removeEventListener('message', handleResult);
        closed = true;
        setTimeout(() => window.close(), 700);
        return;
      }

      const message =
        typeof event.data.error === 'string' && event.data.error.length > 0
          ? event.data.error
          : 'Failed to complete authorization';
      setStatus(`Authorization failed: ${message}`);
    };

    window.addEventListener('message', handleResult);

    window.opener.postMessage(
      { type: 'MCP_AUTH_CODE', code, sessionId: state },
      window.location.origin
    );

    return () => {
      if (!closed) {
        window.removeEventListener('message', handleResult);
      }
    };
  }, [blockingStatus, code, state]);

  return (
    <div className="text-center text-zinc-100">
      <p className="text-lg">{blockingStatus ?? status}</p>
    </div>
  );
}

export default function OAuthCallbackPopup() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-900">
      <Suspense fallback={<div className="text-zinc-100">Loading...</div>}>
        <OAuthCallbackContent />
      </Suspense>
    </div>
  );
}
