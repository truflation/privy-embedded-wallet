import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_CODE,
  MAX_BATCH_CALLS,
  TRANSACTION_STATUS,
  type Address,
  type SendCallsRequest,
} from '../../src/protocol/index';
import { sendIdempotencyKey } from '../../src/server/idempotency';
import type { AuthorizeTransaction } from '../../src/server/types';
import { upstream } from './fake-gateway';
import {
  HOODI,
  OTHER_TO,
  SEPOLIA,
  SEPOLIA_MAX_VALUE,
  TEST_JWT,
  TO,
  expectCode,
  otherSession,
  session,
  setup,
  txRequest,
} from './helpers';

const REQUEST_ID = '8f14e45f-ceea-4e7a-9c3b-1d2e3f4a5b6c';
const SECOND_TO = '0x3333333333333333333333333333333333333333';
const POLICY = 'policy-1';

/** A valid two-call batch from `from`: approve-like, then deposit-like. */
function callsRequest(
  from: Address,
  overrides: Partial<SendCallsRequest> = {},
): SendCallsRequest {
  return {
    requestId: crypto.randomUUID(),
    from,
    chainId: SEPOLIA,
    calls: [
      { to: TO, data: '0x095ea7b3' },
      { to: SECOND_TO, data: '0xb6b55f25', value: '0x0' },
    ],
    ...overrides,
  };
}

async function withWallet(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup({
    chains: {
      [SEPOLIA]: {
        sponsor: true,
        allow: { to: [TO, SECOND_TO], maxValue: SEPOLIA_MAX_VALUE },
      },
      [HOODI]: { sponsor: false },
    },
    ...options,
  });
  const { address } = await ctx.service.ensureWallet(session);
  return { ...ctx, address };
}

/** Nothing reached Privy's wallet API. */
function expectNothingSent(fake: ReturnType<typeof setup>['fake']) {
  expect(fake.calls.authorize).toHaveLength(0);
  expect(fake.calls.sendCalls).toHaveLength(0);
  expect(fake.calls.sendTransaction).toHaveLength(0);
  expect(fake.transactions.size).toBe(0);
}

describe('sendCalls', () => {
  it('sends the calls in order as one sponsored batch, checksummed', async () => {
    const { fake, service, address } = await withWallet();
    const request = callsRequest(address, {
      requestId: REQUEST_ID,
      from: address.toLowerCase() as Address,
    });

    const sent = await service.sendCalls(session, request);

    expect(sent).toEqual({ id: sent.id, status: TRANSACTION_STATUS.PENDING });
    expect(fake.calls.sendCalls).toHaveLength(1);
    const { walletId, input } = fake.calls.sendCalls[0]!;
    expect(walletId).toBe(fake.wallets[0]!.id);
    expect(input).toEqual({
      chainId: SEPOLIA,
      calls: [
        { to: getAddress(TO), data: '0x095ea7b3' },
        { to: getAddress(SECOND_TO), data: '0xb6b55f25', value: '0x0' },
      ],
      idempotencyKey: sendIdempotencyKey(session.userId, REQUEST_ID),
    });
    expect(fake.calls.sendTransaction).toHaveLength(0);
  });

  it('omits data and value on calls that have none', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendCalls(
      session,
      callsRequest(address, { calls: [{ to: TO }] }),
    );
    expect(fake.calls.sendCalls[0]!.input.calls).toEqual([
      { to: getAddress(TO) },
    ]);
  });

  it('reads the batch back through getTransaction, with its chain', async () => {
    const { fake, service, address } = await withWallet();
    const sent = await service.sendCalls(session, callsRequest(address));
    const tx = fake.transactions.get(sent.id)!;
    expect(await service.getTransaction(session, sent.id)).toEqual({
      id: sent.id,
      status: TRANSACTION_STATUS.PENDING,
      chainId: SEPOLIA,
    });
    tx.status = 'confirmed';
    tx.hash = `0x${'ab'.repeat(32)}`;
    expect(await service.getTransaction(session, sent.id)).toEqual({
      id: sent.id,
      status: TRANSACTION_STATUS.CONFIRMED,
      chainId: SEPOLIA,
      hash: tx.hash,
    });
  });

  it('accepts exactly MAX_BATCH_CALLS calls', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendCalls(
      session,
      callsRequest(address, {
        calls: Array.from({ length: MAX_BATCH_CALLS }, () => ({ to: TO })),
      }),
    );
    expect(fake.calls.sendCalls[0]!.input.calls).toHaveLength(MAX_BATCH_CALLS);
  });

  it('lists the sponsored chains as batch chains', async () => {
    const { service } = setup({
      chains: {
        [SEPOLIA]: { sponsor: true, allow: { to: [TO] } },
        [HOODI]: { sponsor: false },
        1: { sponsor: true, allow: { to: [TO] } },
      },
    });
    expect(service.batchChainIds).toEqual([1, SEPOLIA]);
    expect(Object.isFrozen(service.batchChainIds)).toBe(true);
  });
});

describe('sendCalls refusals: nothing reaches Privy', () => {
  it('refuses an unsponsored chain with BATCH_NOT_SUPPORTED', async () => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.sendCalls(session, callsRequest(address, { chainId: HOODI })),
      ERROR_CODE.BATCH_NOT_SUPPORTED,
    );
    expectNothingSent(fake);
  });

  it('refuses an unconfigured chain with CHAIN_NOT_SUPPORTED', async () => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.sendCalls(session, callsRequest(address, { chainId: 1 })),
      ERROR_CODE.CHAIN_NOT_SUPPORTED,
    );
    expectNothingSent(fake);
  });

  it('refuses the whole batch when one call is off the allow list', async () => {
    const hook = vi.fn<AuthorizeTransaction>(() => true);
    const { fake, service, address, log } = await withWallet({
      authorizeTransaction: hook,
    });
    await expectCode(
      service.sendCalls(
        session,
        callsRequest(address, { calls: [{ to: TO }, { to: OTHER_TO }] }),
      ),
      ERROR_CODE.POLICY_DENIED,
    );
    // The static rules refuse before the host hook sees any call.
    expect(hook).not.toHaveBeenCalled();
    expectNothingSent(fake);
    expect(log.entries).toContainEqual({
      level: 'warn',
      message: 'Transaction outside the chain allow list was refused',
      context: { chainId: SEPOLIA, index: 1 },
    });
  });

  it('refuses the whole batch when one call carries more than maxValue', async () => {
    const { fake, service, address } = await withWallet();
    const above = `0x${(SEPOLIA_MAX_VALUE + 1n).toString(16)}` as const;
    await expectCode(
      service.sendCalls(
        session,
        callsRequest(address, {
          calls: [
            { to: TO, value: '0x1' },
            { to: TO, value: above },
          ],
        }),
      ),
      ERROR_CODE.POLICY_DENIED,
    );
    expectNothingSent(fake);
  });

  it('refuses another from address with ACCOUNT_MISMATCH', async () => {
    const { fake, service } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    await expectCode(
      service.sendCalls(session, callsRequest(other.address)),
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
    expectNothingSent(fake);
  });

  it('requires a wallet', async () => {
    const { fake, service } = setup();
    await expectCode(
      service.sendCalls(session, callsRequest(TO)),
      ERROR_CODE.WALLET_NOT_FOUND,
    );
    expectNothingSent(fake);
  });

  it('requires the session to match its token', async () => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.sendCalls(
        { userId: session.userId, jwt: otherSession.jwt },
        callsRequest(address),
      ),
      ERROR_CODE.UNAUTHENTICATED,
    );
    expectNothingSent(fake);
  });

  it.each([
    ['an empty batch', { calls: [] }],
    [
      'more than MAX_BATCH_CALLS calls',
      {
        calls: Array.from({ length: MAX_BATCH_CALLS + 1 }, () => ({ to: TO })),
      },
    ],
    ['a call with a short to', { calls: [{ to: TO }, { to: '0x1234' }] }],
    ['a call with odd-length data', { calls: [{ to: TO, data: '0x123' }] }],
    ['a call with a decimal value', { calls: [{ to: TO, value: '100' }] }],
    ['a call with an unknown field', { calls: [{ to: TO, gas: '0x5208' }] }],
    ['a call that is not an object', { calls: [TO] }],
    ['calls that are not an array', { calls: { to: TO } }],
    ['a non-UUID requestId', { requestId: 'retry-1' }],
    ['a malformed from', { from: '0x1234' }],
    ['a zero chainId', { chainId: 0 }],
    [
      'more data in total than one transaction may carry',
      {
        calls: [
          { to: TO, data: `0x${'00'.repeat(40 * 1024)}` },
          { to: TO, data: `0x${'00'.repeat(40 * 1024)}` },
        ],
      },
    ],
  ])('rejects %s with INVALID_REQUEST', async (_, overrides) => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.sendCalls(
        session,
        callsRequest(
          address,
          overrides as unknown as Partial<SendCallsRequest>,
        ),
      ),
      ERROR_CODE.INVALID_REQUEST,
    );
    expectNothingSent(fake);
  });

  it('cannot send from a wallet the JWT does not own, even if the store says so', async () => {
    const { fake, service, store } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    const otherRecord = await store.get(otherSession.userId);
    await store.put({ ...otherRecord!, userId: session.userId });
    await expectCode(
      service.sendCalls(session, callsRequest(other.address)),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(fake.transactions.size).toBe(0);
  });
});

describe('authorizeTransaction for a batch', () => {
  it('runs once per call, in order, with the shared requestId and the batch position', async () => {
    const hook = vi.fn<AuthorizeTransaction>(() => true);
    const { service, address } = await withWallet({
      authorizeTransaction: hook,
    });
    const request = callsRequest(address, { requestId: REQUEST_ID });
    await service.sendCalls(session, request);

    expect(hook).toHaveBeenCalledTimes(2);
    const [[firstSession, first], [, second]] = hook.mock.calls as [
      Parameters<AuthorizeTransaction>,
      Parameters<AuthorizeTransaction>,
    ];
    expect(firstSession).toEqual(session);
    expect(first).toEqual({
      requestId: REQUEST_ID,
      from: address,
      chainId: SEPOLIA,
      to: getAddress(TO),
      data: '0x095ea7b3',
      batch: { index: 0, size: 2 },
    });
    expect(second).toEqual({
      requestId: REQUEST_ID,
      from: address,
      chainId: SEPOLIA,
      to: getAddress(SECOND_TO),
      data: '0xb6b55f25',
      value: '0x0',
      batch: { index: 1, size: 2 },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.batch)).toBe(true);
  });

  it('gives a single send no batch field, as before', async () => {
    const hook = vi.fn<AuthorizeTransaction>(() => true);
    const { service, address } = await withWallet({
      authorizeTransaction: hook,
    });
    await service.sendTransaction(session, txRequest(address));
    expect(hook.mock.calls[0]![1]).not.toHaveProperty('batch');
  });

  it('refuses the whole batch when the hook denies one call, and stops there', async () => {
    const hook = vi.fn<AuthorizeTransaction>((_, tx) => tx.batch?.index !== 1);
    const { fake, service, address } = await withWallet({
      authorizeTransaction: hook,
    });
    await expectCode(
      service.sendCalls(
        session,
        callsRequest(address, { calls: [{ to: TO }, { to: TO }, { to: TO }] }),
      ),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(hook).toHaveBeenCalledTimes(2);
    expectNothingSent(fake);
  });

  it.each([
    [
      'a throw',
      () => {
        throw new Error('boom');
      },
    ],
    ['a rejection', () => Promise.reject(new Error('boom'))],
    ['a truthy non-boolean', () => 1 as unknown as boolean],
  ])('treats %s on any call as a denial of the batch', async (_, impl) => {
    let calls = 0;
    const { fake, service, address } = await withWallet({
      authorizeTransaction: (session, tx) => {
        calls++;
        return tx.batch?.index === 0 ? true : impl();
      },
    });
    await expectCode(
      service.sendCalls(session, callsRequest(address)),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(calls).toBe(2);
    expectNothingSent(fake);
  });

  it('lets a hook-only sponsored chain gate every call', async () => {
    const { fake, service, address } = await withWallet({
      chains: { [SEPOLIA]: { sponsor: true } },
      authorizeTransaction: (_, tx) => tx.to === getAddress(TO),
    });
    await expectCode(
      service.sendCalls(
        session,
        callsRequest(address, { calls: [{ to: TO }, { to: OTHER_TO }] }),
      ),
      ERROR_CODE.POLICY_DENIED,
    );
    expectNothingSent(fake);
    await service.sendCalls(
      session,
      callsRequest(address, { calls: [{ to: TO }, { to: TO }] }),
    );
    expect(fake.calls.sendCalls).toHaveLength(1);
  });
});

describe('idempotent batches (rule 1)', () => {
  it('returns the original batch for a replay, without sending again', async () => {
    const { fake, service, address } = await withWallet();
    const request = callsRequest(address, { requestId: REQUEST_ID });
    const first = await service.sendCalls(session, request);
    const replay = await service.sendCalls(session, {
      ...request,
      requestId: REQUEST_ID.toUpperCase(),
    });
    expect(replay).toEqual(first);
    expect(fake.transactions.size).toBe(1);
    const [a, b] = fake.calls.sendCalls;
    expect(b!.input.idempotencyKey).toBe(a!.input.idempotencyKey);
  });

  it('runs the gates again on a replay', async () => {
    const hook = vi.fn<AuthorizeTransaction>(() => true);
    const { service, address } = await withWallet({
      authorizeTransaction: hook,
    });
    const request = callsRequest(address, { requestId: REQUEST_ID });
    await service.sendCalls(session, request);
    await service.sendCalls(session, request);
    expect(hook).toHaveBeenCalledTimes(4);
  });

  it('shares the key with a single send, so one requestId sends at most once', async () => {
    const { fake, service, address } = await withWallet();
    const single = await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID }),
    );
    const batch = await service.sendCalls(
      session,
      callsRequest(address, { requestId: REQUEST_ID }),
    );
    expect(batch.id).toBe(single.id);
    expect(fake.transactions.size).toBe(1);
  });

  it('sends separately for different requestIds', async () => {
    const { fake, service, address } = await withWallet();
    const a = await service.sendCalls(session, callsRequest(address));
    const b = await service.sendCalls(session, callsRequest(address));
    expect(a.id).not.toBe(b.id);
    expect(fake.transactions.size).toBe(2);
  });

  it('scopes the key per user', async () => {
    const { fake, service, address } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    await service.sendCalls(
      session,
      callsRequest(address, { requestId: REQUEST_ID }),
    );
    await service.sendCalls(
      otherSession,
      callsRequest(other.address, { requestId: REQUEST_ID }),
    );
    const [a, b] = fake.calls.sendCalls;
    expect(a!.input.idempotencyKey).not.toBe(b!.input.idempotencyKey);
    expect(fake.transactions.size).toBe(2);
  });
});

describe('sendCalls upstream failures', () => {
  it('fails when Privy returns no transaction id', async () => {
    const { fake, service, address, log } = await withWallet();
    fake.setSendCallsResult(() => ({ transactionId: undefined }));
    await expectCode(
      service.sendCalls(session, callsRequest(address)),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(log.text()).toContain('no transaction id for a batch');
  });

  it.each([
    [upstream('unauthorized', 401), ERROR_CODE.REAUTH_REQUIRED],
    [
      upstream('rejected', 400, 'insufficient balance for gas sponsorship'),
      ERROR_CODE.INSUFFICIENT_FUNDS,
    ],
    [
      upstream('forbidden', 403, 'Transaction denied by policy'),
      ERROR_CODE.POLICY_DENIED,
    ],
    [upstream('rejected', 400), ERROR_CODE.PROVIDER_ERROR],
    [upstream('unavailable', 502), ERROR_CODE.PROVIDER_ERROR],
  ] as const)('maps %s to %s', async (error, code) => {
    const { fake, service, address, log } = await withWallet();
    fake.failWith('sendCalls', error);
    const thrown = await expectCode(
      service.sendCalls(session, callsRequest(address)),
      code,
    );
    expect(thrown.message).not.toContain(error.detail);
    expect(log.text()).not.toContain(TEST_JWT);
  });

  it('maps a rejected JWT exchange to REAUTH_REQUIRED before sending', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith('authorize', upstream('unauthorized', 401));
    await expectCode(
      service.sendCalls(session, callsRequest(address)),
      ERROR_CODE.REAUTH_REQUIRED,
    );
    expect(fake.calls.sendCalls).toHaveLength(0);
  });
});

describe('sendCalls and configured policies (rule 5)', () => {
  function withLegacyWallet() {
    const ctx = setup({
      policyIds: [POLICY],
      chains: { [SEPOLIA]: { sponsor: true, allow: { to: [TO, SECOND_TO] } } },
    });
    const user = ctx.fake.addUser(session.userId);
    const wallet = ctx.fake.addWallet(user.id, []);
    return { ...ctx, wallet, address: getAddress(wallet.address) };
  }

  it('attaches a missing policy before sending the batch', async () => {
    const { fake, service, wallet, address } = withLegacyWallet();
    fake.failWith('updateWallet', upstream('unavailable', 503));
    await service.ensureWallet(session);
    fake.clearFailures();
    await service.sendCalls(session, callsRequest(address));
    expect(wallet.policyIds).toEqual([POLICY]);
    expect(fake.calls.sendCalls).toHaveLength(1);
  });

  it('refuses the batch when the policy cannot be attached', async () => {
    const { fake, service, address } = withLegacyWallet();
    fake.failWith('updateWallet', upstream('forbidden', 403));
    await service.ensureWallet(session);
    await expectCode(
      service.sendCalls(session, callsRequest(address)),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.sendCalls).toHaveLength(0);
  });
});
