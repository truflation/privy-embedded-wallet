import { ERROR_CODE } from '../protocol/index';
import { walletError } from './errors';
import type { Logger } from './logger';
import { MAX_JWT_LENGTH, MAX_USER_ID_LENGTH } from './limits';
import type { Session } from './types';

/** The JWT claim that carries the host's user id unless configured. */
export const DEFAULT_USER_ID_CLAIM = 'sub';

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The payload of a compact JWS (`header.payload.signature`), or null when the
 * token does not have that shape. The signature is NOT verified: that is the
 * host's job in `authenticate`, and Privy verifies it again on every call.
 * This only reads the claims so they can be compared with the session.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  if (jwt.length > MAX_JWT_LENGTH) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1]!;
  if (!BASE64URL_SEGMENT.test(payload)) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const claims: unknown = JSON.parse(utf8.decode(bytes));
    if (
      typeof claims !== 'object' ||
      claims === null ||
      Array.isArray(claims)
    ) {
      return null;
    }
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readUserIdClaim(claim: string | undefined): string {
  if (claim === undefined) return DEFAULT_USER_ID_CLAIM;
  if (typeof claim !== 'string' || claim.length === 0) {
    throw new TypeError('userIdClaim must be a non-empty string.');
  }
  return claim;
}

/**
 * Builds the check every service method runs first. A session is accepted
 * only when its fields are well formed and its JWT names the same user: the
 * claim `userIdClaim` must be a string equal to `session.userId`. This stops
 * a host bug that pairs one user's id with another user's token from acting
 * on the wrong wallet, since the store is keyed by `userId` while Privy binds
 * the token to its own subject.
 */
export function createSessionCheck(
  userIdClaim: string,
  logger: Logger,
): (session: Session) => void {
  return function assertSession(session) {
    if (
      typeof session?.userId !== 'string' ||
      session.userId.length === 0 ||
      session.userId.length > MAX_USER_ID_LENGTH ||
      typeof session.jwt !== 'string' ||
      session.jwt.length === 0
    ) {
      throw walletError(ERROR_CODE.UNAUTHENTICATED);
    }
    const claims = decodeJwtPayload(session.jwt);
    if (!claims) {
      logger.warn('Session token is not a decodable JWT');
      throw walletError(ERROR_CODE.UNAUTHENTICATED);
    }
    const subject = Object.hasOwn(claims, userIdClaim)
      ? claims[userIdClaim]
      : undefined;
    if (subject !== session.userId) {
      // Values are not logged: either could identify a user.
      logger.warn('Session user id does not match its token', {
        claim: userIdClaim,
      });
      throw walletError(ERROR_CODE.UNAUTHENTICATED);
    }
  };
}
