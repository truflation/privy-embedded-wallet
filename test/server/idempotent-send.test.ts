import { describe, expect, it } from 'vitest';
import { ERROR_CODE } from '../../src/protocol/index';
import {
  sendIdempotencyKey,
  sendReferenceId,
} from '../../src/server/idempotency';
import { upstream } from './fake-gateway';
import {
  OTHER_TO,
  TO,
  expectCode,
  otherSession,
  session,
  setup,
  txRequest,
} from './helpers';

const REQUEST_ID = '8f14e45f-ceea-4e7a-9c3b-1d2e3f4a5b6c';

async function withWallet() {
  const ctx = setup({
    chains: {
      11155111: { sponsor: true, allow: { to: [TO, OTHER_TO] } },
    },
  });
  const { address } = await ctx.service.ensureWallet(session);
  return { ...ctx, address };
}

describe('idempotent sends (rule 1)', () => {
  it('derives both Privy keys from the user and the requestId', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID }),
    );
    const { input } = fake.calls.sendTransaction[0]!;
    expect(input.idempotencyKey).toBe(
      sendIdempotencyKey(session.userId, REQUEST_ID),
    );
    expect(input.referenceId).toBe(sendReferenceId(session.userId, REQUEST_ID));
    expect(input.referenceId).not.toBe(input.idempotencyKey);
  });

  it('returns the original transaction for a replay, without sending again', async () => {
    const { fake, service, address } = await withWallet();
    const request = txRequest(address, { requestId: REQUEST_ID });

    const first = await service.sendTransaction(session, request);
    const replay = await service.sendTransaction(session, { ...request });

    expect(replay).toEqual(first);
    expect(fake.transactions.size).toBe(1);
    const [a, b] = fake.calls.sendTransaction;
    expect(b!.input.idempotencyKey).toBe(a!.input.idempotencyKey);
    expect(b!.input.referenceId).toBe(a!.input.referenceId);
  });

  it('treats a requestId that differs only in case as the same intent', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID }),
    );
    await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID.toUpperCase() }),
    );
    expect(fake.transactions.size).toBe(1);
  });

  it('sends separately for different requestIds', async () => {
    const { fake, service, address } = await withWallet();
    const a = await service.sendTransaction(session, txRequest(address));
    const b = await service.sendTransaction(session, txRequest(address));
    expect(a.id).not.toBe(b.id);
    expect(fake.transactions.size).toBe(2);
  });

  it('scopes the keys per user, so one user cannot collide with another', () => {
    expect(sendIdempotencyKey('user-1', REQUEST_ID)).not.toBe(
      sendIdempotencyKey('user-2', REQUEST_ID),
    );
    expect(sendReferenceId('user-1', REQUEST_ID)).not.toBe(
      sendReferenceId('user-2', REQUEST_ID),
    );
    // JSON framing: no user id can shift text into the requestId slot.
    expect(sendIdempotencyKey('a:b', 'c')).not.toBe(
      sendIdempotencyKey('a', 'b:c'),
    );
  });

  it('lets two users use the same requestId independently', async () => {
    const { fake, service, address } = await withWallet();
    const other = await service.ensureWallet(otherSession);
    await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID }),
    );
    await service.sendTransaction(
      otherSession,
      txRequest(other.address, { requestId: REQUEST_ID }),
    );
    expect(fake.transactions.size).toBe(2);
  });

  it('never sends a different body under a reused requestId', async () => {
    // Behaviour, not detection: the body is not part of the key, so Privy
    // answers the second request from its idempotency cache with the first
    // transaction. Detecting the changed body would need Privy to report
    // it; the SDK documents nothing either way.
    const { fake, service, address } = await withWallet();
    const first = await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID, to: TO }),
    );
    const second = await service.sendTransaction(
      session,
      txRequest(address, { requestId: REQUEST_ID, to: OTHER_TO }),
    );
    expect(second.id).toBe(first.id);
    expect(fake.transactions.size).toBe(1);
  });

  it('does not send again after the idempotency window when the reference id is taken', async () => {
    const { fake, service, address } = await withWallet();
    const request = txRequest(address, { requestId: REQUEST_ID });
    await service.sendTransaction(session, request);
    fake.expireIdempotency();
    await expectCode(
      service.sendTransaction(session, request),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(fake.transactions.size).toBe(1);
  });

  it('keeps the key stable across a retry after an ambiguous failure', async () => {
    const { fake, service, address } = await withWallet();
    const request = txRequest(address, { requestId: REQUEST_ID });
    fake.failWith('sendTransaction', upstream('unavailable'));
    await expectCode(
      service.sendTransaction(session, request),
      ERROR_CODE.PROVIDER_ERROR,
    );
    fake.clearFailures();
    await service.sendTransaction(session, request);
    const keys = fake.calls.sendTransaction.map((c) => c.input.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(fake.transactions.size).toBe(1);
  });
});
