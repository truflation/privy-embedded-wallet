import { ERROR_CODE, type ErrorCode } from '../protocol/index';
import { EmbeddedWalletClientError } from './errors';

/** EIP-1193 and JSON-RPC error codes used by the provider. */
export const RPC_ERROR_CODE = {
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN: 4902,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TRANSACTION_FAILED: -32000,
  RESOURCE_NOT_FOUND: -32001,
  TRANSACTION_REJECTED: -32003,
} as const;

/** The EIP-1193 `ProviderRpcError` shape. */
export class EmbeddedProviderError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(
    code: number,
    message: string,
    options?: { data?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ProviderRpcError';
    this.code = code;
    this.data = options?.data;
  }
}

const RPC_CODE_BY_PROTOCOL_CODE: Record<ErrorCode, number> = {
  [ERROR_CODE.UNAUTHENTICATED]: RPC_ERROR_CODE.UNAUTHORIZED,
  [ERROR_CODE.REAUTH_REQUIRED]: RPC_ERROR_CODE.UNAUTHORIZED,
  [ERROR_CODE.ACCOUNT_MISMATCH]: RPC_ERROR_CODE.UNAUTHORIZED,
  [ERROR_CODE.WALLET_NOT_FOUND]: RPC_ERROR_CODE.UNAUTHORIZED,
  [ERROR_CODE.INVALID_REQUEST]: RPC_ERROR_CODE.INVALID_PARAMS,
  [ERROR_CODE.CHAIN_NOT_SUPPORTED]: RPC_ERROR_CODE.UNRECOGNIZED_CHAIN,
  [ERROR_CODE.POLICY_DENIED]: RPC_ERROR_CODE.TRANSACTION_REJECTED,
  [ERROR_CODE.INSUFFICIENT_FUNDS]: RPC_ERROR_CODE.TRANSACTION_FAILED,
  [ERROR_CODE.TRANSACTION_NOT_FOUND]: RPC_ERROR_CODE.RESOURCE_NOT_FOUND,
  [ERROR_CODE.PROVIDER_ERROR]: RPC_ERROR_CODE.INTERNAL,
};

/** Converts anything thrown inside the provider into a `ProviderRpcError`. */
export function toProviderError(error: unknown): EmbeddedProviderError {
  if (error instanceof EmbeddedProviderError) return error;
  if (error instanceof EmbeddedWalletClientError) {
    return new EmbeddedProviderError(
      RPC_CODE_BY_PROTOCOL_CODE[error.code],
      error.message,
      { data: { code: error.code }, cause: error },
    );
  }
  return new EmbeddedProviderError(
    RPC_ERROR_CODE.INTERNAL,
    error instanceof Error ? error.message : 'Unknown wallet error.',
    { cause: error },
  );
}

/** Returns the same error with extra fields merged into its `data`. */
export function withErrorData(
  error: unknown,
  extra: Record<string, unknown>,
): EmbeddedProviderError {
  const err = toProviderError(error);
  const data =
    typeof err.data === 'object' && err.data !== null ? err.data : {};
  return new EmbeddedProviderError(err.code, err.message, {
    data: { ...data, ...extra },
    cause: err.cause,
  });
}
