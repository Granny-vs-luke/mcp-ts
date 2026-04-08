const DEFAULT_SANDBOX_TIMEOUT_MS = 10000;

export async function setupSandboxProxyIframe(
  iframe: HTMLIFrameElement,
  sandboxProxyUrl: URL
): Promise<{
  onReady: Promise<void>;
}> {
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.backgroundColor = 'transparent';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads');

  const onReady = new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', messageListener);
      iframe.removeEventListener('error', errorListener);
    };

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Timed out waiting for sandbox proxy iframe to be ready'));
      }
    }, DEFAULT_SANDBOX_TIMEOUT_MS);

    const messageListener = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow) {
        const type = event.data?.type || event.data?.method;
        if (type === 'ui-proxy-iframe-ready' || type === 'ext-apps/sandbox-proxy-ready') {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            resolve();
          }
        }
      }
    };

    const errorListener = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(new Error('Failed to load sandbox proxy iframe'));
      }
    };

    window.addEventListener('message', messageListener);
    iframe.addEventListener('error', errorListener);
  });

  iframe.src = sandboxProxyUrl.href;

  return { onReady };
}
