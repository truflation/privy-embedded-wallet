import { describe, expect, it } from 'vitest';
import {
  TRANSACTION_STATUS,
  createEmbeddedWalletService,
  createMemoryWalletStore,
  type SendCallsRequest,
  type Session,
  type TransactionAuthorizationRequest,
  type TransactionResponse,
} from '../../src/server/index';

/**
 * Sends one sponsored batch of two zero-value calls from the test wallet to
 * itself on Sepolia, through Privy's `wallet_sendCalls`, and follows it until
 * it settles. Checks what only a live run can show: that Privy accepts the
 * batch on a sponsored chain, that a replay with the same `requestId` returns
 * the same transaction, and that the transaction can be read back by id with
 * its hash and chain.
 *
 * Runs only when PRIVY_APP_ID, PRIVY_APP_SECRET, TEST_USER_JWT and
 * PRIVY_BATCH_TEST=1 are all set, against a Privy development app with gas
 * sponsorship enabled for Sepolia (11155111). It spends sponsored gas
 * credits. Observations are logged with a `[batch-test]` prefix; nothing
 * secret is printed.
 */

// Read through globalThis to match the other integration tests.
const env =
  (
    globalThis as {
      process?: { env: Record<string, string | undefined> };
    }
  ).process?.env ?? {};
const appId = env.PRIVY_APP_ID;
const appSecret = env.PRIVY_APP_SECRET;
const jwt = env.TEST_USER_JWT;
const enabled = Boolean(
  appId && appSecret && jwt && env.PRIVY_BATCH_TEST === '1',
);

const SEPOLIA = 11155111;
const SETTLE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const observe = (message: string, detail?: unknown) =>
  console.info(`[batch-test] ${message}`, detail ?? '');

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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)('sponsored batch against a Privy dev app', () => {
  it('sends two zero-value self calls as one batch and follows it to a hash', async () => {
    const session: Session = { userId: subjectOf(jwt!), jwt: jwt! };
    const seen: TransactionAuthorizationRequest[] = [];
    const service = createEmbeddedWalletService({
      appId: appId!,
      appSecret: appSecret!,
      store: createMemoryWalletStore(),
      chains: { [SEPOLIA]: { sponsor: true } },
      // Only zero-value, empty calls from the wallet to itself.
      authorizeTransaction: (_, tx) => {
        seen.push(tx);
        return (
          tx.to === tx.from &&
          (tx.value ?? '0x0') === '0x0' &&
          tx.data === undefined
        );
      },
    });
    expect(service.batchChainIds).toEqual([SEPOLIA]);

    const { address } = await service.ensureWallet(session);
    const request: SendCallsRequest = {
      requestId: crypto.randomUUID(),
      from: address,
      chainId: SEPOLIA,
      calls: [
        { to: address, value: '0x0' },
        { to: address, value: '0x0' },
      ],
    };

    const sent = await service.sendCalls(session, request);
    observe('submitted', sent);
    expect(sent.status).toBe(TRANSACTION_STATUS.PENDING);
    expect(seen.map((tx) => tx.batch)).toEqual([
      { index: 0, size: 2 },
      { index: 1, size: 2 },
    ]);
    expect(new Set(seen.map((tx) => tx.requestId)).size).toBe(1);

    const replay = await service.sendCalls(session, request);
    observe('replayed', replay);
    expect(replay.id).toBe(sent.id);

    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let tx: TransactionResponse = await service.getTransaction(
      session,
      sent.id,
    );
    while (tx.status === TRANSACTION_STATUS.PENDING && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      tx = await service.getTransaction(session, sent.id);
    }
    observe('settled', tx);
    expect(tx.status).toBe(TRANSACTION_STATUS.CONFIRMED);
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(tx.chainId).toBe(SEPOLIA);
  }, 240_000);
});
