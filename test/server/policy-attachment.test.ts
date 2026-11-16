import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { ERROR_CODE } from '../../src/protocol/index';
import { upstream } from './fake-gateway';
import { expectCode, session, setup, txRequest } from './helpers';

const POLICY = 'policy-1';

/** A Privy user with a wallet that predates the policy configuration. */
function withLegacyWallet() {
  const ctx = setup({ policyIds: [POLICY] });
  const user = ctx.fake.addUser(session.userId);
  const wallet = ctx.fake.addWallet(user.id, []);
  return { ...ctx, wallet, address: getAddress(wallet.address) };
}

describe('recovered wallets carry the configured policy (rule 5)', () => {
  it('attaches the policy to a recovered wallet that lacks it', async () => {
    const { fake, service, store, wallet } = withLegacyWallet();
    const result = await service.ensureWallet(session);
    expect(result.created).toBe(false);
    expect(fake.calls.updateWallet).toEqual([
      { walletId: wallet.id, policyIds: [POLICY] },
    ]);
    expect(wallet.policyIds).toEqual([POLICY]);
    expect((await store.get(session.userId))?.policyIds).toEqual([POLICY]);
  });

  it('does not update a wallet that already has the policy', async () => {
    const { fake, service, address } = withLegacyWallet();
    fake.wallets[0]!.policyIds = [POLICY];
    await service.ensureWallet(session);
    await service.signMessage(session, { address, message: 'hi' });
    expect(fake.calls.updateWallet).toHaveLength(0);
  });

  it('records new wallets with the policy they were created with', async () => {
    const { fake, service, store } = setup({ policyIds: [POLICY] });
    await service.ensureWallet(session);
    expect((await store.get(session.userId))?.policyIds).toEqual([POLICY]);
    expect(fake.calls.updateWallet).toHaveLength(0);
  });

  it('refuses sign and send, and logs an error, when the policy cannot be attached', async () => {
    const { fake, service, store, address, log } = withLegacyWallet();
    fake.failWith('updateWallet', upstream('forbidden', 403));

    const result = await service.ensureWallet(session);
    expect(result.address).toBe(address);
    expect((await store.get(session.userId))?.policyIds).toEqual([]);
    expect(log.entries.some((e) => e.level === 'error')).toBe(true);

    await expectCode(
      service.signMessage(session, { address, message: 'hi' }),
      ERROR_CODE.POLICY_DENIED,
    );
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.signMessage).toHaveLength(0);
    expect(fake.calls.sendTransaction).toHaveLength(0);
    expect(
      log.entries.filter((e) => e.level === 'error').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('refuses when Privy accepts the update but does not attach the policy', async () => {
    const { fake, service, address } = withLegacyWallet();
    fake.ignorePolicyUpdates();
    await service.ensureWallet(session);
    await expectCode(
      service.signMessage(session, { address, message: 'hi' }),
      ERROR_CODE.POLICY_DENIED,
    );
  });

  it('heals on the next use once attaching succeeds', async () => {
    const { fake, service, store, address } = withLegacyWallet();
    fake.failWith('updateWallet', upstream('unavailable', 503));
    await service.ensureWallet(session);
    fake.clearFailures();

    await service.signMessage(session, { address, message: 'hi' });
    expect((await store.get(session.userId))?.policyIds).toEqual([POLICY]);
    expect(fake.calls.signMessage).toHaveLength(1);
  });

  it('attaches the policy to a record stored before policyIds was configured', async () => {
    const { fake, service, store, wallet, address } = withLegacyWallet();
    await store.put({
      userId: session.userId,
      privyUserId: fake.users.get(session.userId)!.id,
      walletId: wallet.id,
      address,
    });
    await service.sendTransaction(session, txRequest(address));
    expect(fake.calls.updateWallet).toHaveLength(1);
    expect(fake.calls.sendTransaction).toHaveLength(1);
    expect((await store.get(session.userId))?.policyIds).toEqual([POLICY]);
  });

  it('reports a 401 while attaching as REAUTH_REQUIRED', async () => {
    const { fake, service, address } = withLegacyWallet();
    fake.failWith('updateWallet', upstream('unauthorized', 401));
    await service.ensureWallet(session);
    await expectCode(
      service.signMessage(session, { address, message: 'hi' }),
      ERROR_CODE.REAUTH_REQUIRED,
    );
  });
});
