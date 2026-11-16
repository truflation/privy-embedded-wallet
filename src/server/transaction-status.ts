import { isHex } from 'viem';
import {
  TRANSACTION_STATUS,
  type Hex,
  type TransactionStatus,
} from '../protocol/index';
import type { PrivyTransactionStatus } from './privy/gateway';

/**
 * Privy status to protocol status.
 *
 * - `pending`, `broadcasted`: submitted, not yet in a block -> pending.
 * - `confirmed`, `finalized`: included on chain -> confirmed.
 * - `execution_reverted`: included but reverted -> failed.
 * - `failed`: Privy gave up on it -> failed.
 * - `provider_error`: the RPC provider failed while handling it. It may still
 *   have reached the network -> pending.
 * - `replaced`: another transaction (for example a fee bump of the same
 *   intent) took this nonce. The replacement may well be mined, so this is
 *   not evidence of failure -> pending.
 *
 * A status Privy adds later maps to pending, not failed. Reporting a
 * transaction that may yet succeed as failed invites the user to send it
 * again, which is worse than polling a little longer.
 */
const STATUS_MAP: Record<PrivyTransactionStatus, TransactionStatus> = {
  pending: TRANSACTION_STATUS.PENDING,
  broadcasted: TRANSACTION_STATUS.PENDING,
  confirmed: TRANSACTION_STATUS.CONFIRMED,
  finalized: TRANSACTION_STATUS.CONFIRMED,
  execution_reverted: TRANSACTION_STATUS.FAILED,
  failed: TRANSACTION_STATUS.FAILED,
  provider_error: TRANSACTION_STATUS.PENDING,
  replaced: TRANSACTION_STATUS.PENDING,
};

export function isKnownPrivyStatus(
  status: string,
): status is PrivyTransactionStatus {
  return Object.hasOwn(STATUS_MAP, status);
}

export function mapTransactionStatus(status: string): TransactionStatus {
  return isKnownPrivyStatus(status)
    ? STATUS_MAP[status]
    : TRANSACTION_STATUS.PENDING;
}

const TRANSACTION_HASH_HEX_LENGTH = 2 + 64;

/**
 * A usable transaction hash, or undefined. Privy returns an empty string or
 * null while a sponsored transaction is still being bundled.
 */
export function toTransactionHash(
  hash: string | null | undefined,
): Hex | undefined {
  if (!hash || hash.length !== TRANSACTION_HASH_HEX_LENGTH) return undefined;
  return isHex(hash, { strict: true }) ? hash : undefined;
}
