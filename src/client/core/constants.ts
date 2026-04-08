/**
 * Standard event types for the MCP App Host <-> Sandbox Proxy protocol.
 */
export const APP_HOST_PROTOCOL = {
  /** 
   * Event sent by the Sandbox Proxy iframe to the Host when it is loaded and ready
   * to receive HTML content or bridge connections.
   */
  PROXY_READY: 'ext-apps/sandbox-proxy-ready',
  
  /** 
   * Legacy version of PROXY_READY used by early internal prototypes.
   */
  PROXY_READY_LEGACY: 'ui-proxy-iframe-ready',

  /**
   * Event sent by the Host to the Sandbox Proxy to inject raw HTML content.
   */
  HTML_CONTENT: 'ui-html-content',
} as const;

/**
 * Default configuration values for the App Host.
 */
export const APP_HOST_DEFAULTS = {
  /** Default timeout for waiting for the sandbox proxy to be ready (ms). */
  SANDBOX_TIMEOUT_MS: 10000,
  
  /** Default host info reported to guest apps. */
  HOST_INFO: { name: 'mcp-ts-host', version: '1.0.0' },

  /** Supported MCP App URI schemes. */
  URI_SCHEMES: ['ui://', 'mcp-app://'] as const,

  /** Default theme for the host context. */
  THEME: 'dark',

  /** Default platform for the host context. */
  PLATFORM: 'web',

  /** Default max height for the iframe container (px). */
  MAX_HEIGHT: 6000,
} as const;
