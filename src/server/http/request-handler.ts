import { ERROR_CODE } from '../../protocol/index';
import { isEmbeddedWalletError, walletError } from '../errors';
import { redact, silentLogger, type Logger } from '../logger';
import type { EmbeddedWalletService, Session } from '../types';
import {
  parseEmptyBody,
  parseExportWalletRequest,
  parseSignMessageRequest,
  parseTransactionRequest,
} from '../validation';
import {
  checkOrigin,
  isJsonContentType,
  readAllowedOrigins,
  readBoundedBody,
} from './request-guards';
import { errorResponse, jsonResponse } from './responses';
import { matchRoute, normalizeBasePath, type RouteMatch } from './routes';

export interface RequestHandlerOptions {
  /** Where the handler is mounted, for example `/api/wallets/embedded`. */
  basePath: string;
  /**
   * Verifies the host session from the request (cookie or bearer token) and
   * returns it, or null when there is none. The handler never derives the
   * user from anything else. For state-changing requests it runs after the
   * origin and content-type checks and after the body has been read, so it
   * must read headers only, never the body.
   */
  authenticate: (request: Request) => Promise<Session | null> | Session | null;
  /** Origins allowed to make state-changing requests. */
  allowedOrigins: readonly string[];
  /** Receives unexpected failures. Defaults to discarding them. */
  logger?: Logger;
}

export type RequestHandler = (request: Request) => Promise<Response>;

const UNEXPECTED_STATUS = 500;

/** Methods that never change state. Every other method is checked first. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Checks that run before `authenticate` on every state-changing request:
 * allowed origin, bounded body, JSON content type. A forged cross-site
 * request is therefore refused before the host's session code (which may
 * refresh cookies or hit a database) ever sees it. Returns the body text or
 * a ready error response.
 */
async function preflight(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const originError = checkOrigin(request, allowedOrigins);
  if (originError) return { ok: false, response: originError };
  const body = await readBoundedBody(request);
  if (!body.ok) return body;
  if (
    body.text.length > 0 &&
    !isJsonContentType(request.headers.get('Content-Type'))
  ) {
    return {
      ok: false,
      response: errorResponse(ERROR_CODE.INVALID_REQUEST, {
        status: 415,
        message: 'Content-Type must be application/json.',
      }),
    };
  }
  return { ok: true, text: body.text };
}

/**
 * One Web-standard handler for every route in `ROUTES`.
 *
 * Order of checks: for any method other than GET and HEAD, the origin, body
 * size and content type; then authenticate; then route and method; then the
 * body shape. Rate limiting is the host's job.
 *
 * The handler sets no CORS headers and never serves OPTIONS (403 for a
 * disallowed origin, otherwise 401 or 405), so it is
 * meant to be served from the same origin as the page. A host that serves it
 * cross-origin must handle CORS preflight itself.
 */
export function createRequestHandler(
  service: EmbeddedWalletService,
  options: RequestHandlerOptions,
): RequestHandler {
  const basePath = normalizeBasePath(options.basePath);
  const allowedOrigins = readAllowedOrigins(options.allowedOrigins);
  if (typeof options.authenticate !== 'function') {
    throw new TypeError('authenticate must be a function.');
  }
  const logger = options.logger ?? silentLogger;

  async function dispatch(
    request: Request,
    session: Session,
    route: RouteMatch,
    bodyText: string,
  ): Promise<Response> {
    if (request.method === 'GET') {
      if (route.name === 'wallet') {
        const wallet = await service.getWallet(session);
        if (!wallet) return errorResponse(ERROR_CODE.WALLET_NOT_FOUND);
        return jsonResponse(200, { address: wallet.address });
      }
      if (route.name === 'getTransaction') {
        return jsonResponse(
          200,
          await service.getTransaction(session, route.id),
        );
      }
    }

    let parsed: unknown = undefined;
    if (bodyText.length > 0) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw walletError(
          ERROR_CODE.INVALID_REQUEST,
          'Request body must be valid JSON.',
        );
      }
    }

    switch (route.name) {
      case 'wallet': {
        // No parameters. An empty body is accepted, as is `{}`.
        if (parsed !== undefined) parseEmptyBody(parsed);
        const wallet = await service.ensureWallet(session);
        return jsonResponse(200, {
          address: wallet.address,
          created: wallet.created,
        });
      }
      case 'signMessage': {
        const { request: signRequest } = parseSignMessageRequest(parsed);
        return jsonResponse(
          200,
          await service.signMessage(session, signRequest),
        );
      }
      case 'submitTransaction': {
        const tx = parseTransactionRequest(parsed);
        return jsonResponse(200, await service.sendTransaction(session, tx));
      }
      case 'exportWallet': {
        const exportRequest = parseExportWalletRequest(parsed);
        return jsonResponse(
          200,
          await service.exportWallet(session, exportRequest),
        );
      }
      default:
        // Unreachable: methods were checked against the route.
        return errorResponse(ERROR_CODE.INVALID_REQUEST, { status: 405 });
    }
  }

  return async function handle(request: Request): Promise<Response> {
    try {
      let bodyText = '';
      if (!SAFE_METHODS.has(request.method)) {
        const checked = await preflight(request, allowedOrigins);
        if (!checked.ok) return checked.response;
        bodyText = checked.text;
      }

      const session = await options.authenticate(request);
      if (!session) return errorResponse(ERROR_CODE.UNAUTHENTICATED);

      const { pathname } = new URL(request.url);
      const route =
        pathname.startsWith(`${basePath}/`) &&
        matchRoute(pathname.slice(basePath.length));
      if (!route) {
        return errorResponse(ERROR_CODE.INVALID_REQUEST, {
          status: 404,
          message: 'Unknown route.',
        });
      }
      if (!(route.methods as readonly string[]).includes(request.method)) {
        return errorResponse(ERROR_CODE.INVALID_REQUEST, {
          status: 405,
          message: 'Method not allowed.',
          headers: { Allow: route.methods.join(', ') },
        });
      }
      return await dispatch(request, session, route, bodyText);
    } catch (error) {
      if (isEmbeddedWalletError(error)) {
        // Messages on EmbeddedWalletError are written by this package only.
        return errorResponse(error.code, { message: error.message });
      }
      logger.error('Unexpected error in embedded wallet handler', {
        error: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? redact(error.message) : undefined,
      });
      return errorResponse(ERROR_CODE.PROVIDER_ERROR, {
        status: UNEXPECTED_STATUS,
        message: 'Something went wrong. Try again later.',
      });
    }
  };
}
