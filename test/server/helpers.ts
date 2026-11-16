import { expect } from 'vitest';
import type {
  Address,
  ErrorCode,
  TransactionRequest,
} from '../../src/protocol/index';
import { EmbeddedWalletError } from '../../src/server/errors';
import type { Logger } from '../../src/server/logger';
import {
  createServiceWithGateway,
  type ServiceOptions,
} from '../../src/server/service';
import { createMemoryWalletStore } from '../../src/server/store';
import type { Session } from '../../src/server/types';
import { createFakeGateway } from './fake-gateway';

export const SEPOLIA = 11155111;
export const HOODI = 560048;

/** On the Sepolia allow list in the default setup. */
export const TO = '0x1111111111111111111111111111111111111111';
/** Not on any allow list. */
export const OTHER_TO = '0x2222222222222222222222222222222222222222';
/** Sepolia's `allow.maxValue` in the default setup. */
export const SEPOLIA_MAX_VALUE = 10n ** 18n;

const JWT_HEADER = 'eyJhbGciOiJSUzI1NiJ9';
const JWT_SIGNATURE = 'c2lnbmF0dXJlLXBhcnQtb2YtdGhlLWp3dA';

/** A JWT-shaped token with the given claims and a dummy signature. */
export function makeJwt(claims: Record<string, unknown>): string {
  const utf8 = new TextEncoder().encode(JSON.stringify(claims));
  const payload = btoa(String.fromCharCode(...utf8))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${JWT_HEADER}.${payload}.${JWT_SIGNATURE}`;
}

// Shaped like a JWT so the redaction checks are meaningful.
export const TEST_JWT = makeJwt({ sub: 'user-1', exp: 9999999999 });
export const OTHER_JWT = makeJwt({ sub: 'user-2', exp: 9999999999 });

export const session: Session = { userId: 'user-1', jwt: TEST_JWT };
export const otherSession: Session = { userId: 'user-2', jwt: OTHER_JWT };

/** A valid send request from `from`, with a fresh requestId. */
export function txRequest(
  from: Address,
  overrides: Partial<TransactionRequest> = {},
): TransactionRequest {
  return {
    requestId: crypto.randomUUID(),
    from,
    chainId: SEPOLIA,
    to: TO,
    ...overrides,
  };
}

export function createRecordingLogger() {
  const entries: { level: string; message: string; context?: unknown }[] = [];
  const logger: Logger = {
    warn: (message, context) =>
      entries.push({ level: 'warn', message, context }),
    error: (message, context) =>
      entries.push({ level: 'error', message, context }),
  };
  return { logger, entries, text: () => JSON.stringify(entries) };
}

export function setup(
  options: Partial<Omit<ServiceOptions, 'store' | 'logger'>> = {},
) {
  const fake = createFakeGateway();
  const store = createMemoryWalletStore();
  const log = createRecordingLogger();
  const service = createServiceWithGateway(
    {
      chains: {
        [SEPOLIA]: {
          sponsor: true,
          allow: { to: [TO], maxValue: SEPOLIA_MAX_VALUE },
        },
        [HOODI]: { sponsor: false },
      },
      ...options,
      store,
      logger: log.logger,
    },
    fake.gateway,
  );
  return { fake, store, log, service };
}

export async function expectCode(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<EmbeddedWalletError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}, but it resolved`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EmbeddedWalletError);
  expect((error as EmbeddedWalletError).code).toBe(code);
  return error as EmbeddedWalletError;
}
