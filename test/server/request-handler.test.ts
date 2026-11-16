import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_CODE,
  ROUTES,
  type ErrorCode,
  type ErrorResponse,
} from '../../src/protocol/index';
import { createRequestHandler } from '../../src/server/http/request-handler';
import { MAX_BODY_BYTES } from '../../src/server/limits';
import type { EmbeddedWalletService } from '../../src/server/types';
import { UPSTREAM_SECRET_TEXT, upstream } from './fake-gateway';
import {
  HOODI,
  SEPOLIA,
  TEST_JWT,
  TO,
  createRecordingLogger,
  otherSession,
  session,
  setup,
} from './helpers';

const BASE = 'https://app.example.com';
const BASE_PATH = '/api/wallets/embedded';
const ORIGIN = 'https://app.example.com';
const REQUEST_ID = '8f14e45f-ceea-4e7a-9c3b-1d2e3f4a5b6c';

/** A valid POST /transactions body. */
const txBody = (from: unknown, extra: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  from,
  chainId: SEPOLIA,
  to: TO,
  ...extra,
});

/** A valid POST /calls body. */
const callsBody = (from: unknown, extra: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  from,
  chainId: SEPOLIA,
  calls: [
    { to: TO, data: '0x1234' },
    { to: TO, value: '0x0' },
  ],
  ...extra,
});

function createHandler(service?: EmbeddedWalletService) {
  const ctx = setup();
  const log = createRecordingLogger();
  const authenticate = vi.fn((request: Request) =>
    request.headers.get('Authorization') === `Bearer ${TEST_JWT}`
      ? session
      : null,
  );
  const handle = createRequestHandler(service ?? ctx.service, {
    basePath: BASE_PATH,
    authenticate,
    allowedOrigins: [ORIGIN],
    logger: log.logger,
  });
  /** Creates the session's wallet and returns its address. */
  const createWallet = async () => {
    const response = await handle(request(ROUTES.WALLET, { method: 'POST' }));
    return ((await response.json()) as { address: string }).address;
  };
  return { ...ctx, handle, handlerLog: log, authenticate, createWallet };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string | null;
  origin?: string | null;
  auth?: boolean;
  headers?: Record<string, string>;
}

function request(path: string, options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  if (options.auth !== false)
    headers.set('Authorization', `Bearer ${TEST_JWT}`);
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  const method = options.method ?? (hasBody ? 'POST' : 'GET');
  if (method !== 'GET' && options.origin !== null) {
    headers.set('Origin', options.origin ?? ORIGIN);
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && options.contentType !== null) {
    headers.set('Content-Type', options.contentType ?? 'application/json');
  }
  return new Request(`${BASE}${BASE_PATH}${path}`, { method, headers, body });
}

async function expectError(
  response: Response,
  status: number,
  code: ErrorCode,
): Promise<ErrorResponse> {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Content-Type')).toContain('application/json');
  const body = (await response.json()) as ErrorResponse;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  return body;
}

async function expectOk(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return (await response.json()) as Record<string, unknown>;
}

describe('authentication', () => {
  it('returns 401 UNAUTHENTICATED on every route without a session', async () => {
    const { handle, fake } = createHandler();
    for (const req of [
      request(ROUTES.WALLET, { auth: false }),
      request(ROUTES.WALLET, { method: 'POST', auth: false }),
      request(ROUTES.SIGN_MESSAGE, {
        body: { address: TO, message: 'hi' },
        auth: false,
      }),
      request(ROUTES.TRANSACTIONS, { body: txBody(TO), auth: false }),
      request(ROUTES.CALLS, { body: callsBody(TO), auth: false }),
      request(`${ROUTES.TRANSACTIONS}/tx1`, { auth: false }),
      request('/nope', { auth: false }),
    ]) {
      await expectError(await handle(req), 401, ERROR_CODE.UNAUTHENTICATED);
    }
    expect(fake.calls.findUser).toBe(0);
  });

  it('returns a generic 500 when authenticate throws', async () => {
    const { service } = setup();
    const log = createRecordingLogger();
    const handle = createRequestHandler(service, {
      basePath: BASE_PATH,
      authenticate: () => {
        throw new Error(`db down ${UPSTREAM_SECRET_TEXT}`);
      },
      allowedOrigins: [ORIGIN],
      logger: log.logger,
    });
    const response = await handle(request(ROUTES.WALLET));
    const body = await expectError(response, 500, ERROR_CODE.PROVIDER_ERROR);
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_SECRET_TEXT);
    expect(log.entries).toHaveLength(1);
  });
});

describe('routes', () => {
  it('GET /wallet returns 404 WALLET_NOT_FOUND, then the address after POST', async () => {
    const { handle } = createHandler();
    await expectError(
      await handle(request(ROUTES.WALLET)),
      404,
      ERROR_CODE.WALLET_NOT_FOUND,
    );

    const created = await expectOk(
      await handle(request(ROUTES.WALLET, { method: 'POST' })),
    );
    expect(created).toEqual({
      address: expect.any(String),
      created: true,
      batchChainIds: [SEPOLIA],
    });

    const again = await expectOk(
      await handle(request(ROUTES.WALLET, { body: {} })),
    );
    expect(again).toEqual({
      address: created.address,
      created: false,
      batchChainIds: [SEPOLIA],
    });

    expect(await expectOk(await handle(request(ROUTES.WALLET)))).toEqual({
      address: created.address,
      batchChainIds: [SEPOLIA],
    });
  });

  it('POST /sign-message signs', async () => {
    const { handle, createWallet } = createHandler();
    const address = await createWallet();
    const body = await expectOk(
      await handle(
        request(ROUTES.SIGN_MESSAGE, { body: { address, message: 'hi' } }),
      ),
    );
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const raw = await expectOk(
      await handle(
        request(ROUTES.SIGN_MESSAGE, {
          body: { address, message: { raw: '0x01' } },
        }),
      ),
    );
    expect(raw.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('POST /transactions submits and GET /transactions/:id reads it', async () => {
    const { handle, createWallet } = createHandler();
    const address = await createWallet();
    const sent = await expectOk(
      await handle(
        request(ROUTES.TRANSACTIONS, {
          body: txBody(address, { data: '0x', value: '0x1' }),
        }),
      ),
    );
    expect(sent).toEqual({ id: expect.any(String), status: 'pending' });
    const read = await expectOk(
      await handle(request(`${ROUTES.TRANSACTIONS}/${String(sent.id)}`)),
    );
    expect(read).toEqual({ id: sent.id, status: 'pending' });
  });

  it('POST /calls submits a batch and GET /transactions/:id reads it', async () => {
    const { handle, createWallet, fake } = createHandler();
    const address = await createWallet();
    const sent = await expectOk(
      await handle(request(ROUTES.CALLS, { body: callsBody(address) })),
    );
    expect(sent).toEqual({ id: expect.any(String), status: 'pending' });
    expect(fake.calls.sendCalls).toHaveLength(1);
    expect(fake.calls.sendCalls[0]!.input.calls).toHaveLength(2);
    const read = await expectOk(
      await handle(request(`${ROUTES.TRANSACTIONS}/${String(sent.id)}`)),
    );
    expect(read).toEqual({ id: sent.id, status: 'pending', chainId: SEPOLIA });
  });

  it('answers a repeated POST /calls with the original batch', async () => {
    const { handle, createWallet, fake } = createHandler();
    const address = await createWallet();
    const first = await expectOk(
      await handle(request(ROUTES.CALLS, { body: callsBody(address) })),
    );
    const replay = await expectOk(
      await handle(request(ROUTES.CALLS, { body: callsBody(address) })),
    );
    expect(replay).toEqual(first);
    expect(fake.transactions.size).toBe(1);
  });

  it('maps batch refusals to the same statuses as a single send', async () => {
    const { handle, createWallet, service, fake } = createHandler();
    const address = await createWallet();
    const other = await service.ensureWallet(otherSession);
    await expectError(
      await handle(request(ROUTES.CALLS, { body: callsBody(other.address) })),
      409,
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
    await expectError(
      await handle(
        request(ROUTES.CALLS, {
          body: callsBody(address, {
            calls: [
              { to: TO },
              { to: '0x2222222222222222222222222222222222222222' },
            ],
          }),
        }),
      ),
      403,
      ERROR_CODE.POLICY_DENIED,
    );
    await expectError(
      await handle(
        request(ROUTES.CALLS, { body: callsBody(address, { chainId: HOODI }) }),
      ),
      400,
      ERROR_CODE.BATCH_NOT_SUPPORTED,
    );
    await expectError(
      await handle(
        request(ROUTES.CALLS, { body: callsBody(address, { chainId: 1 }) }),
      ),
      400,
      ERROR_CODE.CHAIN_NOT_SUPPORTED,
    );
    expect(fake.calls.sendCalls).toHaveLength(0);
  });

  it('answers a repeated POST /transactions with the original transaction', async () => {
    const { handle, createWallet, fake } = createHandler();
    const address = await createWallet();
    const first = await expectOk(
      await handle(request(ROUTES.TRANSACTIONS, { body: txBody(address) })),
    );
    const replay = await expectOk(
      await handle(request(ROUTES.TRANSACTIONS, { body: txBody(address) })),
    );
    expect(replay).toEqual(first);
    expect(fake.transactions.size).toBe(1);
  });

  it('returns 409 ACCOUNT_MISMATCH for another address on sign and send', async () => {
    const { handle, createWallet, service } = createHandler();
    await createWallet();
    const other = await service.ensureWallet(otherSession);
    await expectError(
      await handle(
        request(ROUTES.SIGN_MESSAGE, {
          body: { address: other.address, message: 'hi' },
        }),
      ),
      409,
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
    await expectError(
      await handle(
        request(ROUTES.TRANSACTIONS, { body: txBody(other.address) }),
      ),
      409,
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
  });

  it('returns 403 POLICY_DENIED for a contract off the allow list', async () => {
    const { handle, createWallet } = createHandler();
    const address = await createWallet();
    await expectError(
      await handle(
        request(ROUTES.TRANSACTIONS, {
          body: txBody(address, {
            to: '0x2222222222222222222222222222222222222222',
          }),
        }),
      ),
      403,
      ERROR_CODE.POLICY_DENIED,
    );
  });

  it('returns 400 CHAIN_NOT_SUPPORTED for an unconfigured chain', async () => {
    const { handle, createWallet } = createHandler();
    const address = await createWallet();
    await expectError(
      await handle(
        request(ROUTES.TRANSACTIONS, { body: txBody(address, { chainId: 1 }) }),
      ),
      400,
      ERROR_CODE.CHAIN_NOT_SUPPORTED,
    );
  });

  it('returns 404 TRANSACTION_NOT_FOUND for an unknown transaction', async () => {
    const { handle } = createHandler();
    await handle(request(ROUTES.WALLET, { method: 'POST' }));
    await expectError(
      await handle(request(`${ROUTES.TRANSACTIONS}/missing`)),
      404,
      ERROR_CODE.TRANSACTION_NOT_FOUND,
    );
  });

  it('returns 404 for unknown routes and paths outside the base path', async () => {
    const { handle } = createHandler();
    for (const path of ['/nope', '/wallet/', '/transactions/a/b', '/', '']) {
      await expectError(
        await handle(request(path)),
        404,
        ERROR_CODE.INVALID_REQUEST,
      );
    }
    const outside = new Request(`${BASE}/api/other/wallet`, {
      headers: { Authorization: `Bearer ${TEST_JWT}` },
    });
    await expectError(await handle(outside), 404, ERROR_CODE.INVALID_REQUEST);
    const prefix = new Request(`${BASE}${BASE_PATH}x/wallet`, {
      headers: { Authorization: `Bearer ${TEST_JWT}` },
    });
    await expectError(await handle(prefix), 404, ERROR_CODE.INVALID_REQUEST);
  });

  it('returns 405 with Allow for a wrong method', async () => {
    const { handle } = createHandler();
    const cases: [string, string, string][] = [
      [ROUTES.WALLET, 'DELETE', 'GET, POST'],
      [ROUTES.SIGN_MESSAGE, 'GET', 'POST'],
      [ROUTES.TRANSACTIONS, 'GET', 'POST'],
      [ROUTES.CALLS, 'GET', 'POST'],
      [`${ROUTES.TRANSACTIONS}/tx1`, 'POST', 'GET'],
      [ROUTES.WALLET, 'OPTIONS', 'GET, POST'],
    ];
    for (const [path, method, allow] of cases) {
      const response = await handle(request(path, { method }));
      await expectError(response, 405, ERROR_CODE.INVALID_REQUEST);
      expect(response.headers.get('Allow')).toBe(allow);
    }
  });

  it('accepts a trailing slash on the configured base path', async () => {
    const { service } = setup();
    const handle = createRequestHandler(service, {
      basePath: `${BASE_PATH}/`,
      authenticate: () => session,
      allowedOrigins: [ORIGIN],
    });
    await expectError(
      await handle(request(ROUTES.WALLET)),
      404,
      ERROR_CODE.WALLET_NOT_FOUND,
    );
  });
});

describe('message authorization', () => {
  it('always applies authorizeMessage to POST /sign-message', async () => {
    const hook = vi.fn(() => false);
    const { service, fake } = setup({ authorizeMessage: hook });
    const signMessage = vi.spyOn(service, 'signMessage');
    const { handle, createWallet } = createHandler(service);
    const address = await createWallet();
    await expectError(
      await handle(
        request(ROUTES.SIGN_MESSAGE, { body: { address, message: 'hi' } }),
      ),
      403,
      ERROR_CODE.POLICY_DENIED,
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage.mock.calls[0]).toHaveLength(2);
    expect(fake.calls.signMessage).toHaveLength(0);
  });

  it('rejects a body that tries to set trusted', async () => {
    const hook = vi.fn(() => false);
    const { service, fake } = setup({ authorizeMessage: hook });
    const { handle, createWallet } = createHandler(service);
    const address = await createWallet();
    await expectError(
      await handle(
        request(ROUTES.SIGN_MESSAGE, {
          body: { address, message: 'hi', trusted: true },
        }),
      ),
      400,
      ERROR_CODE.INVALID_REQUEST,
    );
    expect(hook).not.toHaveBeenCalled();
    expect(fake.calls.signMessage).toHaveLength(0);
  });
});

describe('origin and content type', () => {
  it('rejects POSTs from a disallowed or missing origin with 403', async () => {
    const { handle, fake } = createHandler();
    for (const origin of ['https://evil.example', 'null', null]) {
      for (const path of [
        ROUTES.WALLET,
        ROUTES.SIGN_MESSAGE,
        ROUTES.TRANSACTIONS,
        ROUTES.CALLS,
      ]) {
        await expectError(
          await handle(request(path, { body: {}, origin })),
          403,
          ERROR_CODE.INVALID_REQUEST,
        );
      }
    }
    expect(fake.calls.createWallet).toHaveLength(0);
  });

  it('rejects a bad origin before authenticate runs', async () => {
    const { handle, authenticate } = createHandler();
    for (const method of ['POST', 'DELETE', 'OPTIONS']) {
      await expectError(
        await handle(
          request(ROUTES.WALLET, { method, origin: 'https://evil.example' }),
        ),
        403,
        ERROR_CODE.INVALID_REQUEST,
      );
    }
    // Even without a session the answer is about the origin, not the login.
    await expectError(
      await handle(
        request(ROUTES.WALLET, { method: 'POST', origin: null, auth: false }),
      ),
      403,
      ERROR_CODE.INVALID_REQUEST,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body before authenticate runs', async () => {
    const { handle, authenticate } = createHandler();
    await expectError(
      await handle(
        request(ROUTES.SIGN_MESSAGE, {
          rawBody: 'message=hi',
          contentType: 'application/x-www-form-urlencoded',
          auth: false,
        }),
      ),
      415,
      ERROR_CODE.INVALID_REQUEST,
    );
    await expectError(
      await handle(
        request(ROUTES.SIGN_MESSAGE, {
          rawBody: JSON.stringify({ message: 'x'.repeat(MAX_BODY_BYTES) }),
          auth: false,
        }),
      ),
      413,
      ERROR_CODE.INVALID_REQUEST,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('does not require an origin on reads', async () => {
    const { handle } = createHandler();
    const response = await handle(
      request(ROUTES.WALLET, { headers: { Origin: 'https://evil.example' } }),
    );
    expect(response.status).toBe(404);
  });

  it('rejects non-JSON bodies with 415', async () => {
    const { handle } = createHandler();
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'application/json; charset=latin1',
      'application/jsonx',
      null,
    ]) {
      await expectError(
        await handle(
          request(ROUTES.SIGN_MESSAGE, {
            body: { message: 'hi' },
            contentType,
          }),
        ),
        415,
        ERROR_CODE.INVALID_REQUEST,
      );
    }
  });

  it('accepts application/json with a utf-8 charset', async () => {
    const { handle } = createHandler();
    const response = await handle(
      request(ROUTES.WALLET, {
        body: {},
        contentType: 'application/json; charset=UTF-8',
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('body validation', () => {
  async function expectInvalid(path: string, options: RequestOptions) {
    const { handle } = createHandler();
    await handle(request(ROUTES.WALLET, { method: 'POST' }));
    return expectError(
      await handle(request(path, options)),
      400,
      ERROR_CODE.INVALID_REQUEST,
    );
  }

  it('rejects malformed JSON', async () => {
    await expectInvalid(ROUTES.SIGN_MESSAGE, { rawBody: '{"message":' });
  });

  it('rejects a body that is too large with 413', async () => {
    const { handle } = createHandler();
    await expectError(
      await handle(
        request(ROUTES.SIGN_MESSAGE, {
          rawBody: JSON.stringify({ message: 'x'.repeat(MAX_BODY_BYTES) }),
        }),
      ),
      413,
      ERROR_CODE.INVALID_REQUEST,
    );
  });

  it('rejects a body that is not UTF-8', async () => {
    const { handle } = createHandler();
    const req = new Request(`${BASE}${BASE_PATH}${ROUTES.SIGN_MESSAGE}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_JWT}`,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    await expectError(await handle(req), 400, ERROR_CODE.INVALID_REQUEST);
  });

  it.each([
    ['a non-object body', []],
    ['a null body', null],
    ['an unknown field on POST /wallet', { userId: 'someone-else' }],
  ])('rejects %s on POST /wallet', async (_, body) => {
    await expectInvalid(ROUTES.WALLET, { body });
  });

  it.each([
    ['an empty body', undefined],
    ['a missing message', { address: TO }],
    ['a missing address', { message: 'hi' }],
    ['a malformed address', { address: '0x1234', message: 'hi' }],
    ['an unknown field', { address: TO, message: 'hi', userId: 'x' }],
    ['an empty message', { address: TO, message: '' }],
    ['a numeric message', { address: TO, message: 42 }],
    [
      'an oversized message',
      { address: TO, message: 'x'.repeat(16 * 1024 + 1) },
    ],
    ['a lone surrogate', { address: TO, message: '\ud800' }],
    ['odd-length raw hex', { address: TO, message: { raw: '0xabc' } }],
    ['non-hex raw', { address: TO, message: { raw: '0xzz' } }],
    ['empty raw', { address: TO, message: { raw: '0x' } }],
    [
      'raw with an unknown field',
      { address: TO, message: { raw: '0x01', x: 1 } },
    ],
  ])('rejects %s on POST /sign-message', async (_, body) => {
    await expectInvalid(
      ROUTES.SIGN_MESSAGE,
      body === undefined ? { method: 'POST' } : { body },
    );
  });

  it.each([
    ['a missing requestId', txBody(TO, { requestId: undefined })],
    ['a non-UUID requestId', txBody(TO, { requestId: 'retry-1' })],
    ['a numeric requestId', txBody(TO, { requestId: 1 })],
    [
      'a requestId with extra text',
      txBody(TO, { requestId: `${REQUEST_ID}x` }),
    ],
    ['a missing from', txBody(undefined)],
    ['a malformed from', txBody('0x1234')],
    ['a missing chainId', txBody(TO, { chainId: undefined })],
    ['a string chainId', txBody(TO, { chainId: '1' })],
    ['a zero chainId', txBody(TO, { chainId: 0 })],
    ['a fractional chainId', txBody(TO, { chainId: 1.5 })],
    ['a missing to', txBody(TO, { to: undefined })],
    ['a short address', txBody(TO, { to: '0x1234' })],
    [
      'a bad checksum',
      txBody(TO, { to: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa' }),
    ],
    ['odd-length data', txBody(TO, { data: '0x123' })],
    ['non-hex data', txBody(TO, { data: 'hello' })],
    ['null data', txBody(TO, { data: null })],
    ['oversized data', txBody(TO, { data: `0x${'00'.repeat(64 * 1024 + 1)}` })],
    ['a decimal value', txBody(TO, { value: '100' })],
    ['a numeric value', txBody(TO, { value: 100 })],
    ['a value with leading zeros', txBody(TO, { value: '0x01' })],
    ['a value above uint256', txBody(TO, { value: `0x1${'0'.repeat(64)}` })],
    ['an unknown field', txBody(TO, { gas: '0x5208' })],
  ])('rejects %s on POST /transactions', async (_, body) => {
    await expectInvalid(ROUTES.TRANSACTIONS, { body });
  });

  it.each([
    ['a missing requestId', callsBody(TO, { requestId: undefined })],
    ['a non-UUID requestId', callsBody(TO, { requestId: 'retry-1' })],
    ['a malformed from', callsBody('0x1234')],
    ['a string chainId', callsBody(TO, { chainId: '0xaa36a7' })],
    ['missing calls', callsBody(TO, { calls: undefined })],
    ['calls that are not an array', callsBody(TO, { calls: { to: TO } })],
    ['an empty batch', callsBody(TO, { calls: [] })],
    [
      'more than MAX_BATCH_CALLS calls',
      callsBody(TO, { calls: Array.from({ length: 11 }, () => ({ to: TO })) }),
    ],
    ['a call that is not an object', callsBody(TO, { calls: [TO] })],
    ['a call without to', callsBody(TO, { calls: [{ data: '0x' }] })],
    ['a call with a short to', callsBody(TO, { calls: [{ to: '0x1234' }] })],
    [
      'a call with odd-length data',
      callsBody(TO, { calls: [{ to: TO }, { to: TO, data: '0x123' }] }),
    ],
    [
      'a call with a decimal value',
      callsBody(TO, { calls: [{ to: TO, value: '100' }] }),
    ],
    [
      'a call with an unknown field',
      callsBody(TO, { calls: [{ to: TO, gas: '0x5208' }] }),
    ],
    [
      'a call with its own chainId',
      callsBody(TO, { calls: [{ to: TO, chainId: SEPOLIA }] }),
    ],
    [
      'more than 64 KiB of data in total',
      callsBody(TO, {
        calls: [
          { to: TO, data: `0x${'00'.repeat(32 * 1024)}` },
          { to: TO, data: `0x${'00'.repeat(32 * 1024 + 1)}` },
        ],
      }),
    ],
    ['an unknown field', callsBody(TO, { to: TO })],
  ])('rejects %s on POST /calls', async (_, body) => {
    await expectInvalid(ROUTES.CALLS, { body });
  });

  it('rejects a malformed transaction id', async () => {
    await expectInvalid(`${ROUTES.TRANSACTIONS}/a%2Fb`, {});
    await expectInvalid(`${ROUTES.TRANSACTIONS}/${'x'.repeat(129)}`, {});
  });
});

describe('error responses', () => {
  it('map service errors to statuses without upstream text', async () => {
    const cases: [
      Parameters<ReturnType<typeof setup>['fake']['failWith']>,
      number,
      ErrorCode,
    ][] = [
      [
        ['authorize', upstream('unauthorized', 401)],
        401,
        ERROR_CODE.REAUTH_REQUIRED,
      ],
      [
        ['signMessage', upstream('forbidden', 403, 'Policy violation')],
        403,
        ERROR_CODE.POLICY_DENIED,
      ],
      [
        ['signMessage', upstream('forbidden', 403)],
        502,
        ERROR_CODE.PROVIDER_ERROR,
      ],
      [
        ['signMessage', upstream('unavailable', 503)],
        502,
        ERROR_CODE.PROVIDER_ERROR,
      ],
      [
        [
          'signMessage',
          upstream(
            'rejected',
            400,
            `insufficient funds ${UPSTREAM_SECRET_TEXT}`,
          ),
        ],
        502,
        ERROR_CODE.PROVIDER_ERROR,
      ],
    ];
    for (const [failure, status, code] of cases) {
      const { handle, fake, createWallet } = createHandler();
      const address = await createWallet();
      fake.failWith(...failure);
      const response = await handle(
        request(ROUTES.SIGN_MESSAGE, { body: { address, message: 'hi' } }),
      );
      const body = await expectError(response, status, code);
      expect(JSON.stringify(body)).not.toContain(UPSTREAM_SECRET_TEXT);
      expect(JSON.stringify(body)).not.toContain(TEST_JWT);
    }
  });

  it('maps insufficient funds on send to 422', async () => {
    const { handle, fake, createWallet } = createHandler();
    const address = await createWallet();
    fake.failWith(
      'sendTransaction',
      upstream('rejected', 400, `insufficient funds ${UPSTREAM_SECRET_TEXT}`),
    );
    const body = await expectError(
      await handle(request(ROUTES.TRANSACTIONS, { body: txBody(address) })),
      422,
      ERROR_CODE.INSUFFICIENT_FUNDS,
    );
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_SECRET_TEXT);
  });

  it('never returns text from unexpected errors', async () => {
    const service = {
      getWallet: async () => {
        throw new Error(UPSTREAM_SECRET_TEXT);
      },
    } as unknown as EmbeddedWalletService;
    const { handle, handlerLog } = createHandler(service);
    const body = await expectError(
      await handle(request(ROUTES.WALLET)),
      500,
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_SECRET_TEXT);
    expect(handlerLog.entries).toHaveLength(1);
  });
});

describe('configuration', () => {
  const { service } = setup();
  const base = {
    basePath: BASE_PATH,
    authenticate: () => null,
    allowedOrigins: [ORIGIN],
  };

  it('rejects invalid options', () => {
    expect(() =>
      createRequestHandler(service, { ...base, basePath: 'api' }),
    ).toThrow(TypeError);
    expect(() =>
      createRequestHandler(service, { ...base, allowedOrigins: [] }),
    ).toThrow(TypeError);
    expect(() =>
      createRequestHandler(service, {
        ...base,
        allowedOrigins: ['https://example.com/'],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createRequestHandler(service, {
        ...base,
        allowedOrigins: ['example.com'],
      }),
    ).toThrow(TypeError);
  });
});
