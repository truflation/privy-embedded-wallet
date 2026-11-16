import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { hpkeSeal } from '../hpke';
import type { PrivateKeyAccount } from 'viem/accounts';
import type {
  CreateWalletInput,
  PrivyGateway,
  PrivyTransactionRef,
  PrivyWalletRef,
  SendTransactionInput,
  SentTransaction,
} from '../../src/server/privy/gateway';
import {
  UpstreamError,
  type UpstreamErrorKind,
} from '../../src/server/privy/upstream-error';

export const UPSTREAM_SECRET_TEXT = 'UPSTREAM-DETAIL-must-never-leak';

export function upstream(
  kind: UpstreamErrorKind,
  status?: number,
  detail: string = UPSTREAM_SECRET_TEXT,
): UpstreamError {
  return new UpstreamError({ operation: 'fake', kind, status, detail });
}

interface FakeWallet extends PrivyWalletRef {
  account: PrivateKeyAccount;
  privateKey: Hex;
  ownerId: string;
  policyIds: string[];
}

type FailureKey =
  | 'findUser'
  | 'createUser'
  | 'listWallets'
  | 'createWallet'
  | 'updateWallet'
  | 'authorize'
  | 'signMessage'
  | 'sendTransaction'
  | 'getTransaction'
  | 'exportWallet';

/** The `sub` of a test JWT, read the way Privy would after verifying it. */
function subjectOf(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const sub: unknown = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * In-memory stand-in for Privy. Signs with real local keys so signatures
 * verify, and yields to the event loop on writes so concurrency is real.
 *
 * Models the Privy behaviour the service relies on:
 * - A user JWT authorizes only wallets owned by that JWT's user. Signing,
 *   sending or updating another user's wallet fails, as Privy's
 *   authorization signature check would.
 * - Sends with an idempotency key already seen return the cached result
 *   without sending again, until `expireIdempotency()` ends the window.
 * - A `reference_id` is unique per app: reusing one with a new idempotency
 *   key is rejected. This is Privy's documented contract, modeled here, not
 *   observed.
 */
export function createFakeGateway() {
  let nextId = 1;
  let clock = 1_000;
  const users = new Map<string, { id: string }>();
  const wallets: FakeWallet[] = [];
  const transactions = new Map<string, PrivyTransactionRef>();
  const failures = new Map<FailureKey, UpstreamError>();
  const idempotent = new Map<string, SentTransaction>();
  const referenceIds = new Set<string>();
  const calls = {
    findUser: 0,
    createUser: 0,
    listWallets: 0,
    createWallet: [] as CreateWalletInput[],
    updateWallet: [] as { walletId: string; policyIds: readonly string[] }[],
    authorize: [] as string[],
    signMessage: [] as { walletId: string; message: Uint8Array }[],
    sendTransaction: [] as { walletId: string; input: SendTransactionInput }[],
    getTransaction: [] as string[],
    exportWallet: [] as { walletId: string; recipientPublicKey: string }[],
  };
  let sendResult: ((walletId: string) => SentTransaction) | null = null;
  /** When false, `updateWalletPolicies` succeeds but attaches nothing. */
  let honourPolicyUpdates = true;

  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const fail = (key: FailureKey) => {
    const error = failures.get(key);
    if (error) throw error;
  };

  function addUser(customUserId: string) {
    const user = { id: `did:privy:user${nextId++}` };
    users.set(customUserId, user);
    return user;
  }

  function addWallet(ownerId: string, policyIds: string[] = []): FakeWallet {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const wallet: FakeWallet = {
      id: `wallet${nextId++}`,
      address: account.address.toLowerCase(),
      createdAt: clock++,
      account,
      privateKey,
      ownerId,
      policyIds,
    };
    wallets.push(wallet);
    return wallet;
  }

  function addTransaction({
    id,
    ...rest
  }: Omit<PrivyTransactionRef, 'id'> & { id?: string }) {
    const ref: PrivyTransactionRef = { id: id ?? `tx${nextId++}`, ...rest };
    transactions.set(ref.id, ref);
    return ref;
  }

  /** The wallet, if the JWT's user owns it; otherwise an auth failure. */
  function ownedWallet(walletId: string, jwt: string): FakeWallet {
    const wallet = wallets.find((w) => w.id === walletId);
    if (!wallet) throw upstream('not_found', 404);
    const sub = subjectOf(jwt);
    const owner = sub === undefined ? undefined : users.get(sub);
    if (!owner || owner.id !== wallet.ownerId) {
      throw upstream('forbidden', 403, 'invalid authorization signature');
    }
    return wallet;
  }

  const publicRef = (w: FakeWallet): PrivyWalletRef => ({
    id: w.id,
    address: w.address,
    createdAt: w.createdAt,
    policyIds: [...w.policyIds],
  });

  const gateway: PrivyGateway = {
    async findUserByCustomAuthId(customUserId) {
      calls.findUser++;
      await tick();
      fail('findUser');
      return users.get(customUserId) ?? null;
    },
    async createUser(customUserId) {
      calls.createUser++;
      await tick();
      fail('createUser');
      if (users.has(customUserId)) throw upstream('rejected', 400);
      return addUser(customUserId);
    },
    async listUserWallets(privyUserId) {
      calls.listWallets++;
      await tick();
      fail('listWallets');
      return wallets.filter((w) => w.ownerId === privyUserId).map(publicRef);
    },
    async createUserWallet(input) {
      calls.createWallet.push(input);
      await tick();
      fail('createWallet');
      return publicRef(addWallet(input.privyUserId, [...input.policyIds]));
    },
    async updateWalletPolicies(walletId, policyIds, jwt) {
      calls.updateWallet.push({ walletId, policyIds });
      await tick();
      fail('updateWallet');
      const wallet = ownedWallet(walletId, jwt);
      if (honourPolicyUpdates) wallet.policyIds = [...policyIds];
      return publicRef(wallet);
    },
    async authorize(jwt) {
      calls.authorize.push(jwt);
      fail('authorize');
    },
    async signMessage(walletId, message, jwt) {
      calls.signMessage.push({ walletId, message });
      fail('signMessage');
      const wallet = ownedWallet(walletId, jwt);
      return wallet.account.signMessage({ message: { raw: message } });
    },
    async sendTransaction(walletId, input, jwt) {
      calls.sendTransaction.push({ walletId, input });
      fail('sendTransaction');
      ownedWallet(walletId, jwt);
      const cached = idempotent.get(input.idempotencyKey);
      if (cached) return { ...cached };
      if (referenceIds.has(input.referenceId)) {
        throw upstream('conflict', 409, 'reference_id already used');
      }
      let result: SentTransaction;
      if (sendResult) {
        result = sendResult(walletId);
      } else {
        const tx = addTransaction({ walletId, status: 'pending', hash: null });
        result = { hash: '', transactionId: tx.id };
      }
      idempotent.set(input.idempotencyKey, result);
      referenceIds.add(input.referenceId);
      return { ...result };
    },
    async getTransaction(transactionId) {
      calls.getTransaction.push(transactionId);
      fail('getTransaction');
      const tx = transactions.get(transactionId);
      if (!tx) throw upstream('not_found', 404);
      return { ...tx };
    },
    async exportWallet(walletId, recipientPublicKey, jwt) {
      calls.exportWallet.push({ walletId, recipientPublicKey });
      fail('exportWallet');
      const wallet = ownedWallet(walletId, jwt);
      // Encrypts the real key, so a test can decrypt it and check it.
      return {
        ...(await hpkeSeal(recipientPublicKey, wallet.privateKey)),
        encryptionType: 'HPKE',
      };
    },
  };

  return {
    gateway,
    calls,
    users,
    wallets,
    transactions,
    addUser,
    addWallet,
    addTransaction,
    failWith(key: FailureKey, error: UpstreamError) {
      failures.set(key, error);
    },
    clearFailures() {
      failures.clear();
    },
    setSendResult(fn: ((walletId: string) => SentTransaction) | null) {
      sendResult = fn;
    },
    /** Simulates Privy's 24-hour idempotency window passing. */
    expireIdempotency() {
      idempotent.clear();
    },
    ignorePolicyUpdates() {
      honourPolicyUpdates = false;
    },
  };
}

export type FakeGateway = ReturnType<typeof createFakeGateway>;
