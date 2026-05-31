import { customAlphabet } from 'nanoid';

const OAUTH_STATE_SEPARATOR = '.';

/** first char: letters only (required by OpenAI) */
const firstChar = customAlphabet(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    1
);

/** remaining chars: alphanumeric */
const rest = customAlphabet(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    11
);

/**
 * Sanitize server name to create a valid server label
 * Must start with a letter and contain only letters, digits, '-' and '_'
 */
export function sanitizeServerLabel(name: string): string {
  let sanitized = name
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .replace(/_{2,}/g, '_')
    .toLowerCase();

  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = 's_' + sanitized;
  }

  return sanitized;
}

/**
 * Generates a standard 12-character session ID compliant with external tool restrictions.
 * First character is always a letter.
 */
export function generateSessionId(): string {
    return firstChar() + rest();
}

export interface ParsedOAuthState {
  nonce: string;
  sessionId: string;
}

export function formatOAuthState(nonce: string, sessionId: string): string {
  return `${nonce}${OAUTH_STATE_SEPARATOR}${sessionId}`;
}

export function parseOAuthState(state: string): ParsedOAuthState | undefined {
  const separatorIndex = state.indexOf(OAUTH_STATE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === state.length - 1) {
    return undefined;
  }

  const nonce = state.slice(0, separatorIndex);
  const sessionId = state.slice(separatorIndex + 1);
  if (!nonce || !sessionId || sessionId.includes(OAUTH_STATE_SEPARATOR)) {
    return undefined;
  }

  return { nonce, sessionId };
}
