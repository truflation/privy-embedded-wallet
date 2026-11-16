import { getAddress, isAddress } from 'viem';
import { ERROR_CODE, type Address } from '../protocol/index';
import { walletError } from './errors';
import { mapUpstreamError } from './error-mapping';
import { walletIdempotencyKey } from './idempotency';
import type { Logger } from './logger';
import { attachPolicies, carriesPolicies } from './policy-attachment';
import type {
  PrivyGateway,
  PrivyUserRef,
  PrivyWalletRef,
} from './privy/gateway';
import { UpstreamError } from './privy/upstream-error';
import type { WalletRecord, WalletStore } from './store';
import type { EnsureWalletResult, Session } from './types';

export interface ProvisioningDeps {
  gateway: PrivyGateway;
  store: WalletStore;
  policyIds: readonly string[];
  logger: Logger;
}

/**
 * Finds or creates the Privy user and wallet for one host user.
 *
 * Order matters: the store first, then Privy lookups, and only then creation.
 * A lost store record is therefore recovered rather than replaced.
 *
 * Within one process, callers must serialize calls per user (the service
 * does this). Across processes two requests can still race past the lookups.
 * That is narrowed in three ways:
 *
 * 1. A user that already exists when `createUser` runs is re-read.
 * 2. Wallet creation uses an idempotency key derived from the Privy user id,
 *    so Privy should return the first wallet to a racing second request
 *    within its idempotency window.
 * 3. After creating, wallets are listed again and the oldest one wins, so
 *    racing processes converge on the same wallet.
 *
 * If Privy did create two wallets despite this, the newer one is left
 * unused. It is never returned or stored.
 *
 * A wallet that lacks the configured policies (recovered from before they
 * were configured, or created by something else) has them attached with the
 * user's JWT. If that fails the record is still stored, with the policies
 * the wallet really has, so the address is known; sign and send then refuse
 * the wallet until a later attempt succeeds.
 */
export async function provisionWallet(
  deps: ProvisioningDeps,
  session: Session,
): Promise<EnsureWalletResult> {
  const { userId } = session;
  const stored = await deps.store.get(userId);
  if (stored) return { address: stored.address, created: false };

  try {
    const user = await findOrCreateUser(deps.gateway, userId);
    const { wallet, created } = await findOrCreateWallet(deps, user.id);
    const address = toAddress(wallet.address, deps.logger);
    const record: WalletRecord = {
      userId,
      privyUserId: user.id,
      walletId: wallet.id,
      address,
      policyIds: await reconcilePolicies(deps, wallet, session.jwt),
    };
    await deps.store.put(record);
    return { address: record.address, created };
  } catch (error) {
    if (error instanceof UpstreamError) {
      throw mapUpstreamError(error, 'provision', deps.logger);
    }
    throw error;
  }
}

async function findOrCreateUser(
  gateway: PrivyGateway,
  userId: string,
): Promise<PrivyUserRef> {
  const existing = await gateway.findUserByCustomAuthId(userId);
  if (existing) return existing;
  try {
    return await gateway.createUser(userId);
  } catch (error) {
    // Another process may have created the user in the meantime. Privy's
    // exact status for a duplicate custom auth id is not documented in the
    // SDK, so any client error triggers a re-read before giving up.
    if (
      error instanceof UpstreamError &&
      (error.kind === 'conflict' || error.kind === 'rejected')
    ) {
      const raced = await gateway.findUserByCustomAuthId(userId);
      if (raced) return raced;
    }
    throw error;
  }
}

async function findOrCreateWallet(
  deps: ProvisioningDeps,
  privyUserId: string,
): Promise<{ wallet: PrivyWalletRef; created: boolean }> {
  const existing = oldest(await deps.gateway.listUserWallets(privyUserId));
  if (existing) return { wallet: existing, created: false };

  const createdWallet = await deps.gateway.createUserWallet({
    privyUserId,
    policyIds: deps.policyIds,
    idempotencyKey: walletIdempotencyKey(privyUserId, deps.policyIds),
  });

  let listed: PrivyWalletRef[] = [];
  try {
    listed = await deps.gateway.listUserWallets(privyUserId);
  } catch (error) {
    // The wallet exists; failing to re-list only skips convergence.
    if (!(error instanceof UpstreamError)) throw error;
    deps.logger.warn('Could not re-list wallets after creation', {
      operation: error.operation,
      kind: error.kind,
      status: error.status,
    });
  }
  const winner = oldest([...listed, createdWallet]) ?? createdWallet;
  if (winner.id !== createdWallet.id) {
    deps.logger.warn('Concurrent wallet creation detected; using the oldest', {
      privyUserId,
      walletId: winner.id,
      unusedWalletId: createdWallet.id,
    });
  }
  return { wallet: winner, created: winner.id === createdWallet.id };
}

/** Oldest wallet, ties broken by id, so every process picks the same one. */
function oldest(wallets: readonly PrivyWalletRef[]): PrivyWalletRef | null {
  let best: PrivyWalletRef | null = null;
  for (const wallet of wallets) {
    if (
      !best ||
      wallet.createdAt < best.createdAt ||
      (wallet.createdAt === best.createdAt && wallet.id < best.id)
    ) {
      best = wallet;
    }
  }
  return best;
}

/** The policies the stored record should claim for this wallet. */
async function reconcilePolicies(
  deps: ProvisioningDeps,
  wallet: PrivyWalletRef,
  jwt: string,
): Promise<readonly string[]> {
  if (carriesPolicies(wallet.policyIds, deps.policyIds)) {
    return [...wallet.policyIds];
  }
  try {
    const attached = await attachPolicies(
      deps.gateway,
      wallet.id,
      deps.policyIds,
      jwt,
    );
    if (attached) return [...attached];
    deps.logger.error(
      'Privy did not attach the configured policy; the wallet is refused for signing',
      { walletId: wallet.id },
    );
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    deps.logger.error(
      'Could not attach the configured policy; the wallet is refused for signing',
      {
        walletId: wallet.id,
        operation: error.operation,
        kind: error.kind,
        status: error.status,
        detail: error.detail,
      },
    );
  }
  return [...wallet.policyIds];
}

function toAddress(value: string, logger: Logger): Address {
  if (!isAddress(value, { strict: false })) {
    logger.error('Privy returned a wallet without a valid address');
    throw walletError(ERROR_CODE.PROVIDER_ERROR);
  }
  return getAddress(value);
}
