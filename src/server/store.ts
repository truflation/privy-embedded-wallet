import type { Address } from '../protocol/index';

/** What the host persists per user. A cache of what Privy already knows. */
export interface WalletRecord {
  /** The host's user id, the subject of the host session. */
  userId: string;
  privyUserId: string;
  walletId: string;
  /** EIP-55 checksummed. */
  address: Address;
  /**
   * Privy policy ids the wallet was last seen carrying. Persist it with the
   * rest of the record. When it lacks the configured `policyIds` (or is
   * missing), the service attaches them before the next sign or send and
   * refuses to sign or send if that fails.
   */
  policyIds?: readonly string[];
}

/**
 * Host-owned persistence. If a record is lost, `ensureWallet` recovers it
 * from Privy before creating anything, so the store needs no transactions.
 */
export interface WalletStore {
  get(userId: string): Promise<WalletRecord | null>;
  /** Must be an upsert keyed by userId. */
  put(record: WalletRecord): Promise<void>;
}

/**
 * In-memory store for tests and examples. Not for production: records are
 * lost on restart and are not shared between processes.
 */
export function createMemoryWalletStore(): WalletStore {
  const records = new Map<string, WalletRecord>();
  return {
    async get(userId) {
      const record = records.get(userId);
      return record ? copy(record) : null;
    },
    async put(record) {
      records.set(record.userId, copy(record));
    },
  };
}

function copy(record: WalletRecord): WalletRecord {
  return record.policyIds
    ? { ...record, policyIds: [...record.policyIds] }
    : { ...record };
}
