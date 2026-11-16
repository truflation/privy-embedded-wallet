import { isAddress } from 'viem';
import type { TransactionRequest } from '../protocol/index';
import type { ChainConfig } from './types';

/** A chain's config after validation, with the allow list ready to match. */
export interface ChainRules {
  sponsor: boolean;
  allow: { to: ReadonlySet<string>; maxValue: bigint } | null;
}

/** `maxValue` when an allow list does not set one: value transfers denied. */
export const DEFAULT_MAX_VALUE = 0n;

const lower = (address: string) => address.toLowerCase();

function readAllow(
  allow: ChainConfig['allow'],
  key: string,
): ChainRules['allow'] {
  if (allow === undefined) return null;
  if (typeof allow !== 'object' || allow === null) {
    throw new TypeError(`chains[${key}].allow must be an object.`);
  }
  if (!Array.isArray(allow.to) || allow.to.length === 0) {
    throw new TypeError(
      `chains[${key}].allow.to must list at least one address.`,
    );
  }
  const to = new Set<string>();
  for (const address of allow.to as readonly unknown[]) {
    // Strict: a mixed-case address with a wrong checksum is a typo.
    if (typeof address !== 'string' || !isAddress(address)) {
      throw new TypeError(`chains[${key}].allow.to has an invalid address.`);
    }
    to.add(lower(address));
  }
  const maxValue = allow.maxValue ?? DEFAULT_MAX_VALUE;
  if (typeof maxValue !== 'bigint' || maxValue < 0n) {
    throw new TypeError(
      `chains[${key}].allow.maxValue must be a non-negative bigint.`,
    );
  }
  return { to, maxValue };
}

/**
 * Validates the chain config. Throws when a chain sponsors gas with nothing
 * limiting what it sponsors: without an allow list or a hook, any signed-in
 * account could spend the app's gas budget on any transaction.
 */
export function readChains(
  chains: Readonly<Record<number, ChainConfig>>,
  hasHook: boolean,
): ReadonlyMap<number, ChainRules> {
  if (typeof chains !== 'object' || chains === null) {
    throw new TypeError('chains must be an object keyed by chain id.');
  }
  const result = new Map<number, ChainRules>();
  for (const [key, value] of Object.entries(chains)) {
    const chainId = Number(key);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new TypeError(`chains has an invalid chain id: ${key}`);
    }
    if (typeof value?.sponsor !== 'boolean') {
      throw new TypeError(`chains[${key}].sponsor must be a boolean.`);
    }
    const allow = readAllow(value.allow, key);
    if (value.sponsor && !allow && !hasHook) {
      throw new TypeError(
        `chains[${key}] sponsors gas without an allow list or an authorizeTransaction hook.`,
      );
    }
    result.set(chainId, { sponsor: value.sponsor, allow });
  }
  return result;
}

/** True when the transaction is inside the chain's allow list, if any. */
export function passesAllowList(
  rules: ChainRules,
  tx: TransactionRequest,
): boolean {
  if (!rules.allow) return true;
  if (!rules.allow.to.has(lower(tx.to))) return false;
  const value = tx.value === undefined ? 0n : BigInt(tx.value);
  return value <= rules.allow.maxValue;
}

/**
 * Chains that accept batched calls: the sponsored ones, ascending. A
 * sponsored wallet is an EIP-7702 delegated account that can execute calls
 * atomically; an unsponsored one is a plain EOA and cannot.
 */
export function readBatchChainIds(
  chains: ReadonlyMap<number, ChainRules>,
): readonly number[] {
  return Object.freeze(
    [...chains]
      .filter(([, rules]) => rules.sponsor)
      .map(([chainId]) => chainId)
      .sort((a, b) => a - b),
  );
}
