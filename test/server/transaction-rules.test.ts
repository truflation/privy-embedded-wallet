import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODE } from '../../src/protocol/index';
import { createServiceWithGateway } from '../../src/server/service';
import { createMemoryWalletStore } from '../../src/server/store';
import type { AuthorizeTransaction } from '../../src/server/types';
import { createFakeGateway } from './fake-gateway';
import {
  HOODI,
  OTHER_TO,
  SEPOLIA,
  SEPOLIA_MAX_VALUE,
  TEST_JWT,
  TO,
  expectCode,
  session,
  setup,
  txRequest,
} from './helpers';

const CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

async function withWallet(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(options);
  const { address } = await ctx.service.ensureWallet(session);
  return { ...ctx, address };
}

describe('chain allow list (rule 3)', () => {
  it('sends to an allowed contract', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendTransaction(session, txRequest(address));
    expect(fake.calls.sendTransaction).toHaveLength(1);
  });

  it('refuses a contract off the list before calling Privy', async () => {
    const { fake, service, address } = await withWallet();
    await expectCode(
      service.sendTransaction(session, txRequest(address, { to: OTHER_TO })),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.authorize).toHaveLength(0);
    expect(fake.calls.sendTransaction).toHaveLength(0);
  });

  it('matches addresses without regard to case on checksummed config', async () => {
    const { fake, service, address } = await withWallet({
      chains: { [SEPOLIA]: { sponsor: true, allow: { to: [CHECKSUMMED] } } },
    });
    await service.sendTransaction(
      session,
      txRequest(address, {
        to: CHECKSUMMED.toLowerCase() as `0x${string}`,
      }),
    );
    expect(fake.calls.sendTransaction[0]!.input.to).toBe(CHECKSUMMED);
  });

  it('allows value up to maxValue and refuses more', async () => {
    const { fake, service, address } = await withWallet();
    const max = `0x${SEPOLIA_MAX_VALUE.toString(16)}` as const;
    const above = `0x${(SEPOLIA_MAX_VALUE + 1n).toString(16)}` as const;
    await service.sendTransaction(session, txRequest(address, { value: max }));
    await expectCode(
      service.sendTransaction(session, txRequest(address, { value: above })),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.sendTransaction).toHaveLength(1);
  });

  it('defaults maxValue to zero', async () => {
    const { fake, service, address } = await withWallet({
      chains: { [SEPOLIA]: { sponsor: true, allow: { to: [TO] } } },
    });
    await service.sendTransaction(
      session,
      txRequest(address, { value: '0x0' }),
    );
    await expectCode(
      service.sendTransaction(session, txRequest(address, { value: '0x1' })),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.sendTransaction).toHaveLength(1);
  });

  it('applies no list to a chain without one', async () => {
    const { fake, service, address } = await withWallet();
    await service.sendTransaction(
      session,
      txRequest(address, { chainId: HOODI, to: OTHER_TO, value: '0x1' }),
    );
    expect(fake.calls.sendTransaction).toHaveLength(1);
  });
});

describe('authorizeTransaction hook (rule 3)', () => {
  it('receives the session and the validated, checksummed transaction', async () => {
    const hook = vi.fn<AuthorizeTransaction>(() => true);
    const { service, address } = await withWallet({
      authorizeTransaction: hook,
    });
    const request = txRequest(address, {
      from: address.toLowerCase() as `0x${string}`,
      data: '0xabcd',
    });
    await service.sendTransaction(session, request);
    expect(hook).toHaveBeenCalledTimes(1);
    const [seenSession, tx] = hook.mock.calls[0]!;
    expect(seenSession).toEqual(session);
    expect(tx).toEqual({
      ...request,
      from: address,
      to: getAddress(TO),
    });
    expect(Object.isFrozen(tx)).toBe(true);
  });

  it('runs after the allow list, and both must pass', async () => {
    const hook = vi.fn<AuthorizeTransaction>(() => true);
    const { service, address } = await withWallet({
      authorizeTransaction: hook,
    });
    await expectCode(
      service.sendTransaction(session, txRequest(address, { to: OTHER_TO })),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([
    ['false', () => false],
    ['a truthy non-boolean', () => 'yes' as unknown as boolean],
    ['a promise of false', async () => false],
  ])('denies when the hook returns %s', async (_, impl) => {
    const { fake, service, address } = await withWallet({
      authorizeTransaction: impl,
    });
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.authorize).toHaveLength(0);
    expect(fake.calls.sendTransaction).toHaveLength(0);
  });

  it('allows an async true', async () => {
    const { fake, service, address } = await withWallet({
      authorizeTransaction: async () => true,
    });
    await service.sendTransaction(session, txRequest(address));
    expect(fake.calls.sendTransaction).toHaveLength(1);
  });

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
      authorizeTransaction: impl as AuthorizeTransaction,
    });
    await expectCode(
      service.sendTransaction(session, txRequest(address)),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.sendTransaction).toHaveLength(0);
    const entry = log.entries.find((e) => e.level === 'error');
    expect(entry?.message).toContain('authorizeTransaction');
    expect(log.text()).not.toContain(TEST_JWT);
  });
});

describe('sponsorship guard (rule 3)', () => {
  const store = createMemoryWalletStore();
  const gateway = createFakeGateway().gateway;

  it('throws when a sponsored chain has neither an allow list nor a hook', () => {
    expect(() =>
      createServiceWithGateway(
        { store, chains: { [SEPOLIA]: { sponsor: true } } },
        gateway,
      ),
    ).toThrow(TypeError);
  });

  it('accepts a sponsored chain guarded by a hook or an allow list', () => {
    expect(() =>
      createServiceWithGateway(
        {
          store,
          chains: { [SEPOLIA]: { sponsor: true } },
          authorizeTransaction: () => true,
        },
        gateway,
      ),
    ).not.toThrow();
    expect(() =>
      createServiceWithGateway(
        {
          store,
          chains: { [SEPOLIA]: { sponsor: true, allow: { to: [TO] } } },
        },
        gateway,
      ),
    ).not.toThrow();
    expect(() =>
      createServiceWithGateway(
        { store, chains: { [SEPOLIA]: { sponsor: false } } },
        gateway,
      ),
    ).not.toThrow();
  });

  it('rejects malformed allow lists and hooks', () => {
    for (const allow of [
      { to: [] },
      { to: ['0x123'] },
      // Mixed case with a wrong checksum.
      { to: ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa'] },
      { to: [TO], maxValue: -1n },
      { to: [TO], maxValue: 1 },
      null,
    ]) {
      expect(() =>
        createServiceWithGateway(
          {
            store,
            chains: {
              [SEPOLIA]: {
                sponsor: false,
                allow: allow as unknown as { to: `0x${string}`[] },
              },
            },
          },
          gateway,
        ),
      ).toThrow(TypeError);
    }
    expect(() =>
      createServiceWithGateway(
        {
          store,
          chains: {},
          authorizeTransaction: 'yes' as unknown as AuthorizeTransaction,
        },
        gateway,
      ),
    ).toThrow(TypeError);
  });
});
