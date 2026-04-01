import { customAlphabet } from 'nanoid';

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
