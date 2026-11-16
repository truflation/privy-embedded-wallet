import { APIConnectionError, APIError } from '@privy-io/node';
import { redact } from '../logger';

/**
 * Broad class of a Privy failure, derived from the HTTP status the SDK
 * reports. The service turns this into a protocol error code.
 */
export type UpstreamErrorKind =
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'rejected' // any other 4xx except 429
  | 'rate_limited' // 429
  | 'unavailable' // 5xx, connection failures and timeouts
  | 'unknown'; // anything that is not an SDK HTTP error

/**
 * A Privy failure normalized by the gateway. `detail` is redacted upstream
 * text for server logs only. It must never be returned to a client.
 */
export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number | undefined;
  readonly detail: string;
  readonly operation: string;

  constructor(options: {
    operation: string;
    kind: UpstreamErrorKind;
    status?: number;
    detail?: string;
  }) {
    super(`Privy ${options.operation} failed (${options.kind})`);
    this.name = 'UpstreamError';
    this.operation = options.operation;
    this.kind = options.kind;
    this.status = options.status;
    this.detail = redact(options.detail ?? '');
  }
}

function kindForStatus(status: number): UpstreamErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'rejected';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

/** Upstream text used for logs and for narrow classification only. */
function upstreamText(error: unknown): string {
  if (error instanceof APIError) {
    const body: unknown = error.error;
    if (body && typeof body === 'object') {
      try {
        return JSON.stringify(body);
      } catch {
        // Fall through to the message.
      }
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return '';
}

/**
 * Normalizes anything the SDK throws. SDK HTTP errors carry `status`;
 * connection errors and timeouts are `APIConnectionError` with no status.
 */
export function toUpstreamError(
  error: unknown,
  operation: string,
): UpstreamError {
  if (error instanceof UpstreamError) return error;
  const detail = upstreamText(error);
  if (error instanceof APIConnectionError) {
    return new UpstreamError({ operation, kind: 'unavailable', detail });
  }
  if (error instanceof APIError && typeof error.status === 'number') {
    return new UpstreamError({
      operation,
      kind: kindForStatus(error.status),
      status: error.status,
      detail,
    });
  }
  return new UpstreamError({ operation, kind: 'unknown', detail });
}

/**
 * `@privy-io/node` 0.39.0 exposes no machine-readable error code: `APIError`
 * carries only `status`, `headers` and an untyped JSON body (see
 * `core/error.d.ts`), and the status classes (`PermissionDeniedError` and so
 * on) say nothing about the cause. These conditions are therefore recognised
 * from the error text. The match only picks a protocol code; the text itself
 * is never forwarded. Unmatched errors fall back to status-based mapping.
 */
const INSUFFICIENT_FUNDS_PATTERN = /insufficient (funds|balance)/i;

/**
 * Deliberately narrow: the text must say that a policy denied or was
 * violated by the request ("policy violation", "denied by policy", "violates
 * the wallet policy"). Text that merely mentions a policy, such as "policy
 * not found" or "invalid policy id", is a configuration fault and stays a
 * `PROVIDER_ERROR`, so it is not mistaken for a user-facing denial.
 */
const POLICY_DENIAL_PATTERN = new RegExp(
  [
    String.raw`\bpolicy (?:violation|denied|denial)\b`,
    String.raw`\b(?:denied|rejected|not allowed|disallowed) by (?:the |a )?(?:wallet(?:'s)? )?polic(?:y|ies)\b`,
    String.raw`\bviolat(?:es|ed|ing) (?:the |a )?(?:wallet(?:'s)? )?polic(?:y|ies)\b`,
  ].join('|'),
  'i',
);

export function looksLikeInsufficientFunds(error: UpstreamError): boolean {
  return INSUFFICIENT_FUNDS_PATTERN.test(error.detail);
}

/** Only 400-class rejections and 403s can be policy denials. */
export function looksLikePolicyDenial(error: UpstreamError): boolean {
  return (
    (error.kind === 'forbidden' || error.kind === 'rejected') &&
    POLICY_DENIAL_PATTERN.test(error.detail)
  );
}
