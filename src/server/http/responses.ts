import {
  ERROR_CODE,
  type ErrorCode,
  type ErrorResponse,
} from '../../protocol/index';
import { DEFAULT_ERROR_MESSAGE } from '../errors';

/** HTTP status per protocol error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  [ERROR_CODE.UNAUTHENTICATED]: 401,
  [ERROR_CODE.REAUTH_REQUIRED]: 401,
  [ERROR_CODE.WALLET_NOT_FOUND]: 404,
  [ERROR_CODE.INVALID_REQUEST]: 400,
  [ERROR_CODE.CHAIN_NOT_SUPPORTED]: 400,
  [ERROR_CODE.POLICY_DENIED]: 403,
  [ERROR_CODE.ACCOUNT_MISMATCH]: 409,
  [ERROR_CODE.INSUFFICIENT_FUNDS]: 422,
  [ERROR_CODE.TRANSACTION_NOT_FOUND]: 404,
  [ERROR_CODE.PROVIDER_ERROR]: 502,
};

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
}

/**
 * An error response. `status` overrides the code's default for transport
 * problems (wrong method, unknown route, body too large) that share
 * `INVALID_REQUEST`.
 */
export function errorResponse(
  code: ErrorCode,
  options: {
    message?: string;
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response {
  const body: ErrorResponse = {
    error: { code, message: options.message ?? DEFAULT_ERROR_MESSAGE[code] },
  };
  return jsonResponse(
    options.status ?? ERROR_STATUS[code],
    body,
    options.headers,
  );
}
