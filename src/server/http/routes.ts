import { ROUTES } from '../../protocol/index';

export type HttpMethod = 'GET' | 'POST';

export type RouteMatch =
  | { name: 'wallet'; methods: readonly HttpMethod[] }
  | { name: 'signMessage'; methods: readonly HttpMethod[] }
  | { name: 'submitTransaction'; methods: readonly HttpMethod[] }
  | { name: 'exportWallet'; methods: readonly HttpMethod[] }
  | { name: 'getTransaction'; methods: readonly HttpMethod[]; id: string };

const TRANSACTION_PREFIX = `${ROUTES.TRANSACTIONS}/`;

/**
 * Matches a path relative to the base path. Paths are compared exactly; a
 * trailing slash or extra segment is an unknown route. The transaction id is
 * returned still percent-encoded, and validation rejects any `%`.
 */
export function matchRoute(path: string): RouteMatch | null {
  switch (path) {
    case ROUTES.WALLET:
      return { name: 'wallet', methods: ['GET', 'POST'] };
    case ROUTES.SIGN_MESSAGE:
      return { name: 'signMessage', methods: ['POST'] };
    case ROUTES.TRANSACTIONS:
      return { name: 'submitTransaction', methods: ['POST'] };
    case ROUTES.WALLET_EXPORT:
      return { name: 'exportWallet', methods: ['POST'] };
  }
  if (path.startsWith(TRANSACTION_PREFIX)) {
    const id = path.slice(TRANSACTION_PREFIX.length);
    if (id.length > 0 && !id.includes('/')) {
      return { name: 'getTransaction', methods: ['GET'], id };
    }
  }
  return null;
}

/** Validates and normalizes the mount point: leading slash, none trailing. */
export function normalizeBasePath(basePath: string): string {
  if (typeof basePath !== 'string' || !basePath.startsWith('/')) {
    throw new TypeError('basePath must start with "/".');
  }
  if (/[?#]/.test(basePath)) {
    throw new TypeError('basePath must be a plain path.');
  }
  return basePath.replace(/\/+$/, '');
}
