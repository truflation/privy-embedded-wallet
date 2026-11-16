import { verifyMessage } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  createEmbeddedWalletService,
  createMemoryWalletStore,
  type Session,
} from '../../src/server/index';

/**
 * Runs against a real Privy development app. Skipped unless PRIVY_APP_ID,
 * PRIVY_APP_SECRET and TEST_USER_JWT are all set. The JWT must be issued by
 * the auth provider configured in the Privy app's custom auth (JWT) settings,
 * and its `sub` must be the claim Privy uses as the user id. No
 * transactions are sent. Nothing secret is printed. The chain is configured
 * unsponsored because nothing is sent; a sponsored chain would need an
 * allow list or an `authorizeTransaction` hook.
 */

// Read through globalThis because the shared tsconfig has no Node types.
const env =
  (
    globalThis as {
      process?: { env: Record<string, string | undefined> };
    }
  ).process?.env ?? {};
const appId = env.PRIVY_APP_ID;
const appSecret = env.PRIVY_APP_SECRET;
const jwt = env.TEST_USER_JWT;
const enabled = Boolean(appId && appSecret && jwt);

/** The JWT subject, read without verification. Privy verifies it. */
function subjectOf(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('TEST_USER_JWT is not a JWT.');
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  const sub: unknown = (JSON.parse(json) as { sub?: unknown }).sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('TEST_USER_JWT has no sub claim.');
  }
  return sub;
}

describe.skipIf(!enabled)('server against a Privy dev app', () => {
  const session = (): Session => ({ userId: subjectOf(jwt!), jwt: jwt! });
  const service = (store = createMemoryWalletStore()) =>
    createEmbeddedWalletService({
      appId: appId!,
      appSecret: appSecret!,
      store,
      chains: { 11155111: { sponsor: false } },
    });

  it('ensures the same wallet twice, recovers it into an empty store, signs, and reads back', async () => {
    const store = createMemoryWalletStore();
    const wallets = service(store);

    const first = await wallets.ensureWallet(session());
    const second = await wallets.ensureWallet(session());
    expect(second.address).toBe(first.address);
    expect(second.created).toBe(false);

    // A fresh store forces recovery from Privy, which must not create.
    const recovered = await service().ensureWallet(session());
    expect(recovered).toEqual({ address: first.address, created: false });

    const message = `privy-embedded-wallet integration ${new Date().toISOString()}`;
    const { signature } = await wallets.signMessage(session(), {
      address: first.address,
      message,
    });
    expect(
      await verifyMessage({ address: first.address, message, signature }),
    ).toBe(true);

    const raw = '0xdeadbeef' as const;
    const rawSigned = await wallets.signMessage(session(), {
      address: first.address,
      message: { raw },
    });
    expect(
      await verifyMessage({
        address: first.address,
        message: { raw },
        signature: rawSigned.signature,
      }),
    ).toBe(true);

    expect(await wallets.getWallet(session())).toEqual({
      address: first.address,
    });
  }, 60_000);
});
