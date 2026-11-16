import { ERROR_CODE, type ErrorCode } from '../protocol/index';
import { walletError, type EmbeddedWalletError } from './errors';
import { redact, type Logger } from './logger';
import {
  UpstreamError,
  looksLikeInsufficientFunds,
  looksLikePolicyDenial,
  type UpstreamErrorKind,
} from './privy/upstream-error';

/**
 * What the service was doing when Privy failed. The same HTTP status means
 * different things in different steps, so mapping depends on it.
 *
 * - `authorize`: exchanging the user's JWT for the user's signing key.
 * - `sign` / `send` / `export`: the wallet request itself, after the exchange.
 * - `read` / `provision`: app-secret calls with no user token involved.
 *
 * Only a 401 from `authorize`, `sign`, `send` or `export` means the token was refused,
 * so only that asks the user to sign in again (`REAUTH_REQUIRED`).
 */
export type UpstreamStep =
  'authorize' | 'sign' | 'send' | 'export' | 'read' | 'provision';

const CLIENT_ERROR_KINDS: ReadonlySet<UpstreamErrorKind> = new Set([
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rejected',
]);

function codeFor(error: UpstreamError, step: UpstreamStep): ErrorCode {
  switch (step) {
    case 'authorize':
      return error.kind === 'unauthorized'
        ? ERROR_CODE.REAUTH_REQUIRED
        : ERROR_CODE.PROVIDER_ERROR;
    case 'sign':
    case 'send':
    case 'export':
      // A 401 after a successful exchange means the cached key or token
      // stopped being accepted between the two calls.
      if (error.kind === 'unauthorized') return ERROR_CODE.REAUTH_REQUIRED;
      if (step === 'send' && looksLikeInsufficientFunds(error)) {
        return ERROR_CODE.INSUFFICIENT_FUNDS;
      }
      if (looksLikePolicyDenial(error)) return ERROR_CODE.POLICY_DENIED;
      return ERROR_CODE.PROVIDER_ERROR;
    case 'read':
    case 'provision':
      return ERROR_CODE.PROVIDER_ERROR;
  }
}

/**
 * A non-401 client error from the token exchange is not the user's fault:
 * it usually means the Privy app's custom auth settings (issuer, JWKS URL,
 * user id claim) do not match the host's tokens.
 */
function messageFor(error: UpstreamError, step: UpstreamStep): string {
  if (
    step === 'authorize' &&
    error.kind !== 'unauthorized' &&
    CLIENT_ERROR_KINDS.has(error.kind)
  ) {
    return 'Privy rejected the JWT exchange; check the custom auth configuration';
  }
  return 'Privy request failed';
}

/**
 * Converts a failure from a Privy call into the error the client sees, and
 * logs the redacted upstream detail. Nothing upstream reaches the result.
 */
export function mapUpstreamError(
  error: unknown,
  step: UpstreamStep,
  logger: Logger,
): EmbeddedWalletError {
  if (!(error instanceof UpstreamError)) {
    logger.error('Unexpected failure calling Privy', {
      step,
      error: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? redact(error.message) : undefined,
    });
    return walletError(ERROR_CODE.PROVIDER_ERROR);
  }
  const code = codeFor(error, step);
  logger.error(messageFor(error, step), {
    step,
    operation: error.operation,
    kind: error.kind,
    status: error.status,
    code,
    detail: error.detail,
  });
  return walletError(code);
}
