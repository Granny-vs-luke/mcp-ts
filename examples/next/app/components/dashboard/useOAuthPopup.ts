import { useEffect, useRef } from 'react';
import { Connection } from './types';

export function useOAuthPopup(
    connections: Connection[],
    finishAuth: (sessionId: string, code: string) => Promise<unknown>
) {
    const pendingPopupsRef = useRef<Map<string, WindowProxy>>(new Map());

    useEffect(() => {
        const handleMessage = async (event: MessageEvent) => {
            // Security check: ensure message is from same origin
            if (event.origin !== window.location.origin) {
                console.log('Ignored message from different origin:', event.origin);
                return;
            }

            if (event.data?.type === 'MCP_AUTH_CODE' && event.data.code) {
                console.log('Received auth code message', event.data);

                const popupWindow = event.source && 'postMessage' in event.source
                    ? event.source as WindowProxy
                    : null;
                const targetSessionId = typeof event.data.sessionId === 'string' ? event.data.sessionId : '';

                if (!targetSessionId) {
                    console.error('OAuth callback message missing sessionId/state', event.data);
                    popupWindow?.postMessage(
                        {
                            type: 'MCP_AUTH_RESULT',
                            success: false,
                            error: 'Missing OAuth session identifier',
                        },
                        window.location.origin,
                    );
                    return;
                }

                // Bind the code to the exact OAuth state/session returned by the provider,
                // rather than guessing based on whichever connection is currently authenticating.
                const targetSession = connections.find((connection) => connection.sessionId === targetSessionId);

                if (!targetSession) {
                    console.error('Could not find session for OAuth callback state:', targetSessionId, connections);
                    popupWindow?.postMessage(
                        {
                            type: 'MCP_AUTH_RESULT',
                            sessionId: targetSessionId,
                            success: false,
                            error: 'OAuth session not found in the current client state',
                        },
                        window.location.origin,
                    );
                    return;
                }

                console.log('Finishing auth for session:', targetSession.sessionId);
                if (popupWindow) {
                    pendingPopupsRef.current.set(targetSession.sessionId, popupWindow);
                }

                try {
                    await finishAuth(targetSession.sessionId, event.data.code);
                } catch (err) {
                    pendingPopupsRef.current.delete(targetSession.sessionId);
                    const message = err instanceof Error ? err.message : 'Failed to finish auth';
                    console.error('Failed to finish auth:', err);
                    popupWindow?.postMessage(
                        {
                            type: 'MCP_AUTH_RESULT',
                            sessionId: targetSession.sessionId,
                            success: false,
                            error: message,
                        },
                        window.location.origin,
                    );
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [connections, finishAuth]);

    useEffect(() => {
        for (const connection of connections) {
            const popupWindow = pendingPopupsRef.current.get(connection.sessionId);
            if (!popupWindow) {
                continue;
            }

            if (connection.state === 'AUTHENTICATED') {
                popupWindow.postMessage(
                    {
                        type: 'MCP_AUTH_RESULT',
                        sessionId: connection.sessionId,
                        success: true,
                    },
                    window.location.origin,
                );
                pendingPopupsRef.current.delete(connection.sessionId);
                continue;
            }

            if (connection.state === 'FAILED') {
                popupWindow.postMessage(
                    {
                        type: 'MCP_AUTH_RESULT',
                        sessionId: connection.sessionId,
                        success: false,
                        error: connection.error || 'Failed to complete authorization',
                    },
                    window.location.origin,
                );
                pendingPopupsRef.current.delete(connection.sessionId);
            }
        }
    }, [connections]);
}
