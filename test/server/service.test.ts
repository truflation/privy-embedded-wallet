import { getAddress, hexToBytes, stringToBytes, verifyMessage } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODE, TRANSACTION_STATUS } from '../../src/protocol/index';
import { walletIdempotencyKey } from '../../src/server/idempotency';
import { createServiceWithGateway } from '../../src/server/service';
import { createMemoryWalletStore } from '../../src/server/store';
import type { AuthorizeMessage } from '../../src/server/types';
import { UPSTREAM_SECRET_TEXT, upstream } from './fake-gateway';
import {
  HOODI,
  SEPOLIA,
  TEST_JWT,
  TO,
  expectCode,
  otherSession,
  session,
  setup,
  txRequest,
} from './helpers';

const HASH = `0x${'ab'.repeat(32)}` as const;

/** A service with the session's wallet already created. */
async function withWallet(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(options);
  const { address } = await ctx.service.ensureWallet(session);
  return { ...ctx, address };
}

describe('ensureWallet', () => {
  it('creates the user and wallet once, then reuses the stored record', async () => {
    const { fake, service, store } = setup();

    const first = await service.ensureWallet(session);
    const second = await service.ensureWallet(session);

    expect(first.created).toBe(true);
    expect(second).toEqual({ address: first.address, created: false });
    expect(fake.calls.createUser).toBe(1);
    expect(fake.calls.createWallet).toHaveLength(1);
    expect(first.address).toBe(getAddress(first.address));
    const record = await store.get(session.userId);
    expect(record).toMatchObject({
      userId: session.userId,
      address: first.address,
      walletId: fake.wallets[0]!.id,
    });
  });

  it('creates once under concurrent calls for the same user', async () => {
    const { fake, service } = setup();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.ensureWallet(session)),
    );

    expect(fake.calls.createUser).toBe(1);
    expect(fake.calls.createWallet).toHaveLength(1);
    expect(new Set(results.map((r) => r.address)).size).toBe(1);
  });

  it('keeps concurrent calls for different users independent', async () => {
    const { fake, service } = setup();
    const [a, b] = await Promise.all([
      service.ensureWallet(session),
      service.ensureWallet(otherSession),
    ]);
    expect(a.address).not.toBe(b.address);
    expect(fake.calls.createWallet).toHaveLength(2);
  });

  it('recovers from Privy when the store is empty, without creating', async () => {
    const { fake, service, store } = setup();
    const user = fake.addUser(session.userId);
    const wallet = fake.addWallet(user.id);

    const result = await service.ensureWallet(session);

    expect(result).toEqual({
      address: getAddress(wallet.address),
      created: false,
    });
    expect(fake.calls.createUser).toBe(0);
    expect(fake.calls.createWallet).toHaveLength(0);
    expect(await store.get(session.userId)).toMatchObject({
      privyUserId: user.id,
      walletId: wallet.id,
    });
  });

  it('creates only the wallet when the Privy user already exists', async () => {
    const { fake, service } = setup();
    fake.addUser(session.userId);
    const result = await service.ensureWallet(session);
    expect(result.created).toBe(true);
    expect(fake.calls.createUser).toBe(0);
    expect(fake.calls.createWallet).toHaveLength(1);
  });

  it('picks the oldest wallet when Privy has several', async () => {
    const { fake, service } = setup();
    const user = fake.addUser(session.userId);
    const oldest = fake.addWallet(user.id);
    fake.addWallet(user.id);
    const result = await service.ensureWallet(session);
    expect(result.address).toBe(getAddress(oldest.address));
  });

  it('re-reads the user when another process created it first', async () => {
    const { fake, service } = setup();
    // Simulate a racing process: lookup misses, then create reports a
    // duplicate because the user now exists.
    const original = fake.gateway.findUserByCustomAuthId;
    let lookups = 0;
    fake.gateway.findUserByCustomAuthId = async (id) => {
      lookups++;
      if (lookups === 1) {
        fake.addUser(id);
        return null;
      }
      return original(id);
    };

    const result = await service.ensureWallet(session);

    expect(result.created).toBe(true);
    expect(fake.calls.createUser).toBe(1);
    expect(lookups).toBe(2);
  });

  it('converges on the oldest wallet when another process created one too', async () => {
    const { fake, service } = setup();
    const user = fake.addUser(session.userId);
    const originalList = fake.gateway.listUserWallets;
    let lists = 0;
    let racedWallet: { address: string } | undefined;
    fake.gateway.listUserWallets = async (id) => {
      lists++;
      if (lists === 1) {
        // Another process creates its wallet right after our lookup.
        racedWallet = fake.addWallet(user.id);
        return [];
      }
      return originalList(id);
    };

    const result = await service.ensureWallet(session);

    expect(result).toEqual({
      address: getAddress(racedWallet!.address),
      created: false,
    });
  });

  it('sends a deterministic idempotency key that covers the policy config', async () => {
    const { fake, service } = setup({ policyIds: ['policy-1'] });
    await service.ensureWallet(session);
    const input = fake.calls.createWallet[0]!;
    expect(input.policyIds).toEqual(['policy-1']);
    expect(input.idempotencyKey).toBe(
      walletIdempotencyKey(input.privyUserId, ['policy-1']),
    );
    expect(input.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(walletIdempotencyKey('a', [])).not.toBe(
      walletIdempotencyKey('b', []),
    );
    // A changed policy configuration never reuses an earlier key.
    expect(walletIdempotencyKey('a', ['policy-1'])).not.toBe(
      walletIdempotencyKey('a', ['policy-2']),
    );
    expect(walletIdempotencyKey('a', ['policy-1'])).not.toBe(
      walletIdempotencyKey('a', []),
    );
  });

  it('allows a retry after a failed attempt', async () => {
    const { fake, service } = setup();
    fake.failWith('createWallet', upstream('unavailable'));
    await expectCode(service.ensureWallet(session), ERROR_CODE.PROVIDER_ERROR);
    fake.clearFailures();
    const result = await service.ensureWallet(session);
    expect(result.created).toBe(true);
  });

  it('maps Privy failures to PROVIDER_ERROR without upstream text', async () => {
    const { fake, service, log } = setup();
    fake.failWith('findUser', upstream('unavailable', 503));
    const error = await expectCode(
      service.ensureWallet(session),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(error.message).not.toContain(UPSTREAM_SECRET_TEXT);
    expect(log.text()).toContain(UPSTREAM_SECRET_TEXT);
  });
});

describe('getWallet', () => {
  it('reads the store only', async () => {
    const { fake, service } = setup();
    expect(await service.getWallet(session)).toBeNull();
    const user = fake.addUser(session.userId);
    fake.addWallet(user.id);
    // Privy has a wallet, but getWallet must not look there.
    expect(await service.getWallet(session)).toBeNull();
    expect(fake.calls.findUser).toBe(0);

    const { address } = await service.ensureWallet(session);
    expect(await service.getWallet(session)).toEqual({ address });
  });
});

describe('signMessage', () => {
  it('signs a UTF-8 message that verifies', async () => {
    const { fake, service, address } = await withWallet();

    const { signature } = await service.signMessage(session, {
      address,
      message: 'hello',
    });

    expect(await verifyMessage({ address, message: 'hello', signature })).toBe(
      true,
    );
    expect(fake.calls.authorize).toEqual([TEST_JWT]);
  });

  it('signs a 0x-prefixed string as UTF-8 text, not as hex', async () => {
    const { fake, service, address } = await withWallet();
    const { signature } = await service.signMessage(session, {
      address,
      message: '0xabcd',
    });
    expect(fake.calls.signMessage[0]!.message).toEqual(stringToBytes('0xabcd'));
    expect(await verifyMessage({ address, message: '0xabcd', signature })).toBe(
      true,
    );
  });

  it('signs raw bytes', async () => {
    const { fake, service, address } = await withWallet();
    const raw = '0xdeadbeef' as const;
    const { signature } = await service.signMessage(session, {
      address,
      message: { raw },
    });
    expect(fake.calls.signMessage[0]!.message).toEqual(hexToBytes(raw));
    expect(await verifyMessage({ address, message: { raw }, signature })).toBe(
      true,
    );
  });

  it('requires a wallet', async () => {
    const { service } = setup();
    await expectCode(
      service.signMessage(session, { address: TO, message: 'hello' }),
      ERROR_CODE.WALLET_NOT_FOUND,
    );
  });

  it('rejects invalid messages before calling Privy', async () => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.signMessage(session, { address, message: '' }),
      ERROR_CODE.INVALID_REQUEST,
    );
    await expectCode(
      service.signMessage(session, { address, message: { raw: '0xabc' } }),
      ERROR_CODE.INVALID_REQUEST,
    );
    await expectCode(
      service.signMessage(session, {
        address: '0x123' as `0x${string}`,
        message: 'hello',
      }),
      ERROR_CODE.INVALID_REQUEST,
    );
    expect(fake.calls.signMessage).toHaveLength(0);
  });

  it('rejects another address with ACCOUNT_MISMATCH before calling Privy', async () => {
    const { fake, service } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    await expectCode(
      service.signMessage(session, { address: other.address, message: 'hi' }),
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
    expect(fake.calls.authorize).toHaveLength(0);
    expect(fake.calls.signMessage).toHaveLength(0);
  });

  it('matches the address without regard to case', async () => {
    const { service, address } = await withWallet();
    const lower = address.toLowerCase() as `0x${string}`;
    const { signature } = await service.signMessage(session, {
      address: lower,
      message: 'hi',
    });
    expect(await verifyMessage({ address, message: 'hi', signature })).toBe(
      true,
    );
  });

  it('cannot sign with a wallet the JWT does not own, even if the store says so', async () => {
    const { fake, service, store } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    // A corrupted store points user-1 at user-2's wallet. Privy binds the
    // JWT to its owner, so the request fails upstream.
    const otherRecord = await store.get(otherSession.userId);
    await store.put({ ...otherRecord!, userId: session.userId });
    await expectCode(
      service.signMessage(session, { address: other.address, message: 'hi' }),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(fake.calls.signMessage).toHaveLength(1);
  });
});

describe('authorizeMessage hook (rule 11)', () => {
  it('receives the session and the validated, checksummed request', async () => {
    const hook = vi.fn<AuthorizeMessage>(() => true);
    const { fake, service, address } = await withWallet({
      authorizeMessage: hook,
    });
    const lower = address.toLowerCase() as `0x${string}`;
    await service.signMessage(session, { address: lower, message: 'hello' });
    await service.signMessage(session, {
      address,
      message: { raw: '0x01' },
    });
    expect(hook).toHaveBeenCalledTimes(2);
    const [seenSession, request] = hook.mock.calls[0]!;
    expect(seenSession).toEqual(session);
    expect(request).toEqual({ address: getAddress(address), message: 'hello' });
    expect(Object.isFrozen(request)).toBe(true);
    const raw = hook.mock.calls[1]![1];
    expect(raw.message).toEqual({ raw: '0x01' });
    expect(Object.isFrozen(raw.message)).toBe(true);
    expect(fake.calls.signMessage).toHaveLength(2);
  });

  it('allows an async true', async () => {
    const { fake, service, address } = await withWallet({
      authorizeMessage: async () => true,
    });
    await service.signMessage(session, { address, message: 'hello' });
    expect(fake.calls.signMessage).toHaveLength(1);
  });

  it.each([
    ['false', () => false],
    ['a truthy non-boolean', () => 'yes' as unknown as boolean],
    ['a promise of false', async () => false],
  ])(
    'denies before calling Privy when the hook returns %s',
    async (_, impl) => {
      const { fake, service, address } = await withWallet({
        authorizeMessage: impl,
      });
      await expectCode(
        service.signMessage(session, { address, message: 'hello' }),
        ERROR_CODE.POLICY_DENIED,
      );
      expect(fake.calls.authorize).toHaveLength(0);
      expect(fake.calls.signMessage).toHaveLength(0);
    },
  );

  it.each([
    [
      'throws',
      () => {
        throw new Error(`db down ${TEST_JWT}`);
      },
    ],
    ['rejects', () => Promise.reject(new Error(`db down ${TEST_JWT}`))],
  ])('denies and logs when the hook %s', async (_, impl) => {
    const { fake, service, address, log } = await withWallet({
      authorizeMessage: impl as AuthorizeMessage,
    });
    const message = 'secret-message-contents';
    await expectCode(
      service.signMessage(session, { address, message }),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.signMessage).toHaveLength(0);
    const entry = log.entries.find((e) => e.level === 'error');
    expect(entry?.message).toContain('authorizeMessage');
    expect(log.text()).not.toContain(TEST_JWT);
    expect(log.text()).not.toContain(message);
  });

  it('signs unchanged when no hook is configured', async () => {
    const { fake, service, address } = await withWallet();
    await service.signMessage(session, { address, message: 'hello' });
    expect(fake.calls.signMessage).toHaveLength(1);
  });

  it('skips the hook only for trusted: true', async () => {
    const hook = vi.fn<AuthorizeMessage>(() => false);
    const { fake, service, address } = await withWallet({
      authorizeMessage: hook,
    });
    const { signature } = await service.signMessage(
      session,
      { address, message: 'server-built' },
      { trusted: true },
    );
    expect(
      await verifyMessage({ address, message: 'server-built', signature }),
    ).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    for (const options of [
      undefined,
      {},
      { trusted: false },
      { trusted: 'true' as unknown as boolean },
    ]) {
      await expectCode(
        service.signMessage(session, { address, message: 'hi' }, options),
        ERROR_CODE.POLICY_DENIED,
      );
    }
    expect(hook).toHaveBeenCalledTimes(4);
    expect(fake.calls.signMessage).toHaveLength(1);
  });

  it('still checks the account before the hook, trusted or not', async () => {
    const hook = vi.fn<AuthorizeMessage>(() => true);
    const { fake, service } = await withWallet({ authorizeMessage: hook });
    const other = await service.ensureWallet(otherSession);
    for (const options of [undefined, { trusted: true }]) {
      await expectCode(
        service.signMessage(
          session,
          { address: other.address, message: 'hi' },
          options,
        ),
        ERROR_CODE.ACCOUNT_MISMATCH,
      );
    }
    expect(hook).not.toHaveBeenCalled();
    expect(fake.calls.signMessage).toHaveLength(0);
  });
});

describe('JWT rejection', () => {
  it('maps a 401 from the JWT exchange to REAUTH_REQUIRED', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith('authorize', upstream('unauthorized', 401));
    await expectCode(
      service.signMessage(session, { address, message: 'hello' }),
      ERROR_CODE.REAUTH_REQUIRED,
    );
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.REAUTH_REQUIRED,
    );
    expect(fake.calls.signMessage).toHaveLength(0);
    expect(fake.calls.sendTransaction).toHaveLength(0);
  });

  for (const [kind, status] of [
    ['forbidden', 403],
    ['rejected', 400],
    ['not_found', 404],
  ] as const) {
    it(`maps a ${status} from the JWT exchange to PROVIDER_ERROR and logs a config error`, async () => {
      const { fake, service, address, log } = await withWallet();
      fake.failWith('authorize', upstream(kind, status));
      await expectCode(
        service.signMessage(session, { address, message: 'hello' }),
        ERROR_CODE.PROVIDER_ERROR,
      );
      expect(fake.calls.signMessage).toHaveLength(0);
      const entry = log.entries.find((e) => e.level === 'error');
      expect(entry?.message).toContain('custom auth');
    });
  }

  it('maps an outage during the exchange to PROVIDER_ERROR', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith('authorize', upstream('unavailable'));
    await expectCode(
      service.signMessage(session, { address, message: 'hello' }),
      ERROR_CODE.PROVIDER_ERROR,
    );
  });

  it('maps a 401 on the wallet request itself to REAUTH_REQUIRED', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith('signMessage', upstream('unauthorized', 401));
    await expectCode(
      service.signMessage(session, { address, message: 'hello' }),
      ERROR_CODE.REAUTH_REQUIRED,
    );
  });
});

describe('wallet request errors', () => {
  it('maps a bare 403 on signing to PROVIDER_ERROR, not POLICY_DENIED', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith('signMessage', upstream('forbidden', 403));
    await expectCode(
      service.signMessage(session, { address, message: 'hello' }),
      ERROR_CODE.PROVIDER_ERROR,
    );
  });

  it.each([
    ['rejected', 400, 'Transaction denied by policy'],
    ['forbidden', 403, '{"error":"Policy violation: to not allowed"}'],
    ['rejected', 422, 'Request violates the wallet policy'],
  ] as const)(
    'maps a %s with policy-denial text to POLICY_DENIED',
    async (kind, status, detail) => {
      const { fake, service, address } = await withWallet();
      fake.failWith('sendTransaction', upstream(kind, status, detail));
      await expectCode(
        service.sendTransaction(session, txRequest(address)),
        ERROR_CODE.POLICY_DENIED,
      );
    },
  );

  it.each([
    ['forbidden', 403, 'Policy not found'],
    ['rejected', 400, 'Invalid policy id'],
    ['unavailable', 503, 'Transaction denied by policy'],
  ] as const)(
    'does not treat %s "%s" as a policy denial',
    async (kind, status, detail) => {
      const { fake, service, address } = await withWallet();
      fake.failWith('sendTransaction', upstream(kind, status, detail));
      await expectCode(
        service.sendTransaction(session, txRequest(address)),
        ERROR_CODE.PROVIDER_ERROR,
      );
    },
  );

  it('maps insufficient funds on send to INSUFFICIENT_FUNDS', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith(
      'sendTransaction',
      upstream('rejected', 400, 'insufficient funds for gas * price + value'),
    );
    await expectCode(
      service.sendTransaction(session, txRequest(address, { chainId: HOODI })),
      ERROR_CODE.INSUFFICIENT_FUNDS,
    );
  });

  it('maps other client errors and outages to PROVIDER_ERROR', async () => {
    const { fake, service, address } = await withWallet();
    fake.failWith('sendTransaction', upstream('rejected', 400));
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.PROVIDER_ERROR,
    );
    fake.failWith('sendTransaction', upstream('unavailable', 502));
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.PROVIDER_ERROR,
    );
  });
});

describe('sendTransaction', () => {
  it('sends sponsored on a sponsored chain', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendTransaction(
      session,
      txRequest(address, { data: '0x1234', value: '0x0' }),
    );
    const { walletId, input } = fake.calls.sendTransaction[0]!;
    expect(walletId).toBe(fake.wallets[0]!.id);
    expect(input).toMatchObject({
      chainId: SEPOLIA,
      sponsor: true,
      to: getAddress(TO),
      data: '0x1234',
      value: '0x0',
    });
    expect(input.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(input.referenceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends unsponsored on an unsponsored chain', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendTransaction(
      session,
      txRequest(address, { chainId: HOODI }),
    );
    const { input } = fake.calls.sendTransaction[0]!;
    expect(input.sponsor).toBe(false);
    expect(input).not.toHaveProperty('data');
    expect(input).not.toHaveProperty('value');
  });

  it('rejects another from address with ACCOUNT_MISMATCH before calling Privy', async () => {
    const { fake, service } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    await expectCode(
      service.sendTransaction(session, txRequest(other.address)),
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
    expect(fake.calls.authorize).toHaveLength(0);
    expect(fake.calls.sendTransaction).toHaveLength(0);
  });

  it('cannot send from a wallet the JWT does not own, even if the store says so', async () => {
    const { fake, service, store } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    const otherRecord = await store.get(otherSession.userId);
    await store.put({ ...otherRecord!, userId: session.userId });
    await expectCode(
      service.sendTransaction(session, txRequest(other.address)),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(fake.transactions.size).toBe(0);
  });

  it('returns pending with no hash when Privy returns an empty hash, then polls', async () => {
    const { fake, service, address } = await withWallet();

    const sent = await service.sendTransaction(session, txRequest(address));
    expect(sent).toEqual({ id: sent.id, status: TRANSACTION_STATUS.PENDING });
    expect(sent).not.toHaveProperty('hash');

    const tx = fake.transactions.get(sent.id)!;
    expect(await service.getTransaction(session, sent.id)).toEqual({
      id: sent.id,
      status: TRANSACTION_STATUS.PENDING,
    });

    tx.status = 'broadcasted';
    tx.hash = HASH;
    expect(await service.getTransaction(session, sent.id)).toEqual({
      id: sent.id,
      status: TRANSACTION_STATUS.PENDING,
      hash: HASH,
    });

    tx.status = 'confirmed';
    expect(await service.getTransaction(session, sent.id)).toEqual({
      id: sent.id,
      status: TRANSACTION_STATUS.CONFIRMED,
      hash: HASH,
    });
  });

  it('returns the hash when Privy has one immediately', async () => {
    const { fake, service, address } = await withWallet();
    fake.setSendResult(() => ({ hash: HASH, transactionId: 'tx-immediate' }));
    expect(await service.sendTransaction(session, txRequest(address))).toEqual({
      id: 'tx-immediate',
      status: 'pending',
      hash: HASH,
    });
  });

  it('falls back to the hash as id when Privy returns no transaction id', async () => {
    const { fake, service, address } = await withWallet();
    fake.setSendResult(() => ({ hash: HASH, transactionId: undefined }));
    expect(await service.sendTransaction(session, txRequest(address))).toEqual({
      id: HASH,
      status: 'pending',
      hash: HASH,
    });
  });

  it('fails when Privy returns nothing to track', async () => {
    const { fake, service, address } = await withWallet();
    fake.setSendResult(() => ({ hash: '', transactionId: undefined }));
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.PROVIDER_ERROR,
    );
  });

  it('rejects a chain missing from the config', async () => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.sendTransaction(session, txRequest(address, { chainId: 1 })),
      ERROR_CODE.CHAIN_NOT_SUPPORTED,
    );
    expect(fake.calls.authorize).toHaveLength(0);
    expect(fake.calls.sendTransaction).toHaveLength(0);
  });

  it('requires a wallet', async () => {
    const { service } = setup();
    await expectCode(
      service.sendTransaction(session, txRequest(TO)),
      ERROR_CODE.WALLET_NOT_FOUND,
    );
  });

  it('validates the request when called directly', async () => {
    const { service, address } = await withWallet();
    for (const bad of [
      { to: '0x123' as `0x${string}` },
      { requestId: 'not-a-uuid' },
      { requestId: '' },
      { from: '0x123' as `0x${string}` },
    ]) {
      await expectCode(
        service.sendTransaction(session, txRequest(address, bad)),
        ERROR_CODE.INVALID_REQUEST,
      );
    }
  });
});

describe('getTransaction', () => {
  it('rejects a transaction from another wallet like a missing one', async () => {
    const { fake, service, log } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    expect(other.created).toBe(true);
    const sent = await service.sendTransaction(
      otherSession,
      txRequest(other.address),
    );
    fake.transactions.get(sent.id)!.hash = HASH;

    const error = await expectCode(
      service.getTransaction(session, sent.id),
      ERROR_CODE.TRANSACTION_NOT_FOUND,
    );
    expect(error.message).not.toContain(HASH);
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('reports a failed transaction with its hash', async () => {
    const { fake, service, address } = await withWallet();
    const sent = await service.sendTransaction(session, txRequest(address));
    const tx = fake.transactions.get(sent.id)!;
    tx.status = 'execution_reverted';
    tx.hash = HASH;
    expect(await service.getTransaction(session, sent.id)).toEqual({
      id: sent.id,
      status: TRANSACTION_STATUS.FAILED,
      hash: HASH,
    });
  });

  it.each(['replaced', 'provider_error'])(
    'reports %s as pending, since it may still be mined',
    async (status) => {
      const { fake, service, address } = await withWallet();
      const sent = await service.sendTransaction(session, txRequest(address));
      const tx = fake.transactions.get(sent.id)!;
      tx.status = status;
      tx.hash = HASH;
      expect(await service.getTransaction(session, sent.id)).toEqual({
        id: sent.id,
        status: TRANSACTION_STATUS.PENDING,
        hash: HASH,
      });
    },
  );

  it('maps a missing transaction to TRANSACTION_NOT_FOUND', async () => {
    const { service } = await withWallet();
    await expectCode(
      service.getTransaction(session, 'missing'),
      ERROR_CODE.TRANSACTION_NOT_FOUND,
    );
  });

  it('reports TRANSACTION_NOT_FOUND for a user with no wallet', async () => {
    const { fake, service } = setup();
    await expectCode(
      service.getTransaction(session, 'tx1'),
      ERROR_CODE.TRANSACTION_NOT_FOUND,
    );
    expect(fake.calls.getTransaction).toHaveLength(0);
  });

  it('rejects malformed ids before calling Privy', async () => {
    const { fake, service } = await withWallet();
    for (const id of ['', '../wallets', 'a%2Fb', 'x'.repeat(129)]) {
      await expectCode(
        service.getTransaction(session, id),
        ERROR_CODE.INVALID_REQUEST,
      );
    }
    expect(fake.calls.getTransaction).toHaveLength(0);
  });

  it('maps a Privy outage to PROVIDER_ERROR', async () => {
    const { fake, service } = await withWallet();
    fake.failWith('getTransaction', upstream('unavailable', 500));
    await expectCode(
      service.getTransaction(session, 'tx1'),
      ERROR_CODE.PROVIDER_ERROR,
    );
  });
});

describe('logging', () => {
  it('never logs the JWT or a signature', async () => {
    const { fake, service, log, address } = await withWallet();
    const { signature } = await service.signMessage(session, {
      address,
      message: 'hello',
    });
    fake.failWith(
      'signMessage',
      upstream('rejected', 400, `bad request for ${TEST_JWT} ${signature}`),
    );
    await expectCode(
      service.signMessage(session, { address, message: 'hello' }),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.text()).not.toContain(TEST_JWT);
    expect(log.text()).not.toContain(signature.slice(2));
  });
});

describe('configuration', () => {
  const store = createMemoryWalletStore();
  const gateway = setup().fake.gateway;

  it('rejects invalid chains, policies and stores', () => {
    expect(() =>
      createServiceWithGateway(
        { store, chains: { 0: { sponsor: false } } },
        gateway,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createServiceWithGateway(
        {
          store,
          chains: { 1: { sponsor: 'yes' as unknown as boolean } },
        },
        gateway,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createServiceWithGateway(
        { store, chains: {}, policyIds: ['a', 'b'] },
        gateway,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createServiceWithGateway(
        { store: {} as typeof store, chains: {} },
        gateway,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createServiceWithGateway({ store, chains: {}, userIdClaim: '' }, gateway),
    ).toThrow(TypeError);
  });

  it.each([
    ['authorizeTransaction', true],
    ['authorizeMessage', 'allow'],
    ['authorizeMessage', null],
  ])('rejects a non-function %s', (name, value) => {
    expect(() =>
      createServiceWithGateway({ store, chains: {}, [name]: value }, gateway),
    ).toThrow(`${name} must be a function.`);
  });
});
