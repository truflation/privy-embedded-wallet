import { ERROR_CODE, type ErrorCode } from '../protocol/index';

/** Thrown by the HTTP client for every failed call. */
export class EmbeddedWalletClientError extends Error {
  readonly code: ErrorCode;
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbeddedWalletClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Thrown by the connector's `connect()` when the visitor has no host session.
 * The host's `onLoginRequired` callback has already been called by then.
 */
export class LoginRequiredError extends Error {
  readonly code = ERROR_CODE.UNAUTHENTICATED;

  constructor(message = 'Sign in to use your account wallet.') {
    super(message);
    this.name = 'LoginRequiredError';
  }
}
