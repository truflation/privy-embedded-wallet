import { ERROR_CODE } from '../../protocol/index';
import { MAX_BODY_BYTES } from '../limits';
import { errorResponse } from './responses';

/**
 * Request-level checks that run before any body is parsed. Each returns a
 * ready error `Response`, or null when the request passes.
 */

/** Normalizes and validates configured origins once, at handler creation. */
export function readAllowedOrigins(origins: readonly string[]): Set<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError('allowedOrigins must list at least one origin.');
  }
  const result = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError(`allowedOrigins has an invalid origin: ${origin}`);
    }
    if (parsed.origin === 'null' || parsed.origin !== origin) {
      throw new TypeError(
        `allowedOrigins entries must be bare origins such as https://example.com, got: ${origin}`,
      );
    }
    result.add(origin);
  }
  return result;
}

/**
 * State-changing requests must carry an allowed `Origin`. Browsers always
 * send it on cross-origin POSTs, so a missing header is refused too.
 */
export function checkOrigin(
  request: Request,
  allowed: ReadonlySet<string>,
): Response | null {
  const origin = request.headers.get('Origin');
  if (origin && allowed.has(origin)) return null;
  return errorResponse(ERROR_CODE.INVALID_REQUEST, {
    status: 403,
    message: 'Request origin is not allowed.',
  });
}

/** `application/json`, optionally with `charset=utf-8`. Nothing else. */
export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const [type, ...params] = header.split(';').map((part) => part.trim());
  if (type?.toLowerCase() !== 'application/json') return false;
  return params.every((param) => /^charset="?utf-8"?$/i.test(param));
}

export type BodyResult =
  { ok: true; text: string } | { ok: false; response: Response };

const tooLarge = (): BodyResult => ({
  ok: false,
  response: errorResponse(ERROR_CODE.INVALID_REQUEST, {
    status: 413,
    message: 'Request body is too large.',
  }),
});

/**
 * Reads the body as UTF-8 without ever buffering more than the limit,
 * whatever `Content-Length` claims.
 */
export async function readBoundedBody(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) return tooLarge();
  if (!request.body) return { ok: true, text: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      response: errorResponse(ERROR_CODE.INVALID_REQUEST, {
        message: 'Request body could not be read.',
      }),
    };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return {
      ok: false,
      response: errorResponse(ERROR_CODE.INVALID_REQUEST, {
        message: 'Request body must be UTF-8.',
      }),
    };
  }
}
