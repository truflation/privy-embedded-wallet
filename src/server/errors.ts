import { ERROR_CODE, type ErrorCode } from '../protocol/index';

const ERROR_CODES = new Set<string>(Object.values(ERROR_CODE));

/**
 * The only error the service throws for request-level failures. `message` is
 * always written by this package and is safe to return to the browser. It
 * never carries Privy or RPC error text, JWTs or signatures.
 */
export class EmbeddedWalletError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'EmbeddedWalletError';
    this.code = code;
  }
}

export function isEmbeddedWalletError(
  error: unknown,
): error is EmbeddedWalletError {
  return (
    error instanceof EmbeddedWalletError &&
    typeof error.code === 'string' &&
    ERROR_CODES.has(error.code)
  );
}

/** Default public message per code, used when no more specific one applies. */
export const DEFAULT_ERROR_MESSAGE: Record<ErrorCode, string> = {
  [ERROR_CODE.UNAUTHENTICATED]: 'Sign in to use your wallet.',
  [ERROR_CODE.REAUTH_REQUIRED]: 'Your session has expired. Sign in again.',
  [ERROR_CODE.WALLET_NOT_FOUND]: 'No wallet exists for this account yet.',
  [ERROR_CODE.INVALID_REQUEST]: 'The request is not valid.',
  [ERROR_CODE.CHAIN_NOT_SUPPORTED]: 'This chain is not supported.',
  [ERROR_CODE.BATCH_NOT_SUPPORTED]:
    'Batched calls are only supported on sponsored chains.',
  [ERROR_CODE.POLICY_DENIED]: 'The wallet policy does not allow this request.',
  [ERROR_CODE.ACCOUNT_MISMATCH]:
    'The signed-in account does not own this wallet address.',
  [ERROR_CODE.INSUFFICIENT_FUNDS]:
    'The wallet cannot pay for this transaction.',
  [ERROR_CODE.TRANSACTION_NOT_FOUND]: 'Transaction not found.',
  [ERROR_CODE.PROVIDER_ERROR]: 'The wallet provider failed. Try again later.',
};

export function walletError(
  code: ErrorCode,
  message: string = DEFAULT_ERROR_MESSAGE[code],
): EmbeddedWalletError {
  return new EmbeddedWalletError(code, message);
}
