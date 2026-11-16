/**
 * Optional logger for server-side diagnostics. `console` satisfies it.
 * Context objects never contain secrets, JWTs or signatures.
 */
export interface Logger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noop = () => {};

export const silentLogger: Logger = { warn: noop, error: noop };

const MAX_DETAIL_LENGTH = 500;

// Three base64url segments separated by dots: the shape of a JWT.
const JWT_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// 0x followed by 65 bytes or more of hex: signatures and signed payloads.
// Addresses (20 bytes) and hashes (32 bytes) stay readable.
const LONG_HEX_PATTERN = /0x[0-9a-fA-F]{130,}/g;
// Bearer tokens and similar credentials that may be echoed in error text.
const BEARER_PATTERN = /(bearer|basic)\s+[^\s"',]+/gi;

/**
 * Scrubs anything that looks like a JWT, credential or signature from text
 * before it is logged, and truncates it. Upstream error text is only ever
 * logged through this, never returned to clients.
 */
export function redact(text: string): string {
  const scrubbed = text
    .replace(JWT_PATTERN, '[redacted-jwt]')
    .replace(LONG_HEX_PATTERN, '[redacted-hex]')
    .replace(BEARER_PATTERN, '$1 [redacted]');
  return scrubbed.length > MAX_DETAIL_LENGTH
    ? `${scrubbed.slice(0, MAX_DETAIL_LENGTH)}...`
    : scrubbed;
}
