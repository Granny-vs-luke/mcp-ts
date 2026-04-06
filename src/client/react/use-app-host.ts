import { useEffect, useRef, useState, useCallback } from 'react';
import type { SSEClient } from '../core/sse-client';
import { AppHost } from '../core/app-host';

/**
 * Hook to host an MCP App in a React component
 *
 * Initialization is async but optimized for instant availability:
 * - Constructor runs synchronously (sandbox + bridge handler setup)
 * - Host is set in state immediately so launch() can be called right away
 * - start() is a lightweight no-op reserved for future async pre-init work
 * - The real async work (iframe load, bridge connect) happens inside launch()
 *
 * @param client - Connected SSEClient instance
 * @param iframeRef - Reference to the iframe element
 * @param options - Optional configuration
 * @returns Object containing the AppHost instance (or null) and error state
 */
export function useAppHost(
    client: SSEClient,
    iframeRef: React.RefObject<HTMLIFrameElement>,
    options?: {
        /** Callback when the App sends a message (e.g. to chat) */
        onMessage?: (params: { role: string; content: unknown }) => void;
    }
) {
    const [host, setHost] = useState<AppHost | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const initializingRef = useRef(false);

    // Store latest callback in ref to avoid re-initializing AppHost on callback change
    const onMessageRef = useRef(options?.onMessage);
    useEffect(() => {
        onMessageRef.current = options?.onMessage;
    }, [options?.onMessage]);

    useEffect(() => {
        if (!client || !iframeRef.current || initializingRef.current) return;

        // Prevent double initialization in strict mode
        initializingRef.current = true;

        const initHost = async () => {
            try {
                // Initialize AppHost with security enforcement
                const appHost = new AppHost(client, iframeRef.current!);

                // Register message handler
                appHost.onAppMessage = (params) => {
                    onMessageRef.current?.(params);
                };

                // Set host immediately so launch can be called
                // (launch will wait for bridge if needed)
                setHost(appHost);

                // Start bridge connection (this is fast, just sets up PostMessage)
                await appHost.start();
            } catch (err) {
                console.error('[useAppHost] Failed to initialize AppHost:', err);
                setError(err instanceof Error ? err : new Error(String(err)));
            }
        };

        initHost();

        return () => {
            initializingRef.current = false;
            setHost(null);
        };
    }, [client, iframeRef]);

    return { host, error };
}
