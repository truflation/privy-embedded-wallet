import type { PrivyPoliciesService } from '@privy-io/node';
import { getAddress, isAddress } from 'viem';
import type { Address } from '../protocol/index';

export interface WalletPolicyOptions {
  /** Contracts the wallet may call, per EIP-155 chain id. */
  contracts: Readonly<Record<number, readonly Address[]>>;
  /**
   * Largest `value` in wei a transaction may carry, per chain id. Each key
   * must also be in `contracts`. A chain without an entry gets no value
   * condition, so the policy then leaves value unconstrained on that chain.
   */
  maxValue?: Readonly<Record<number, bigint>>;
  /**
   * Emit an explicit ALLOW rule for `personal_sign`. The rule has no
   * conditions: once allowed, any message can be signed.
   */
  allowPersonalSign: boolean;
  /** Policy name shown in the Privy dashboard. */
  name?: string;
}

type TransactionCondition =
  | {
      field_source: 'ethereum_transaction';
      field: 'to' | 'chain_id';
      operator: 'in';
      value: string[];
    }
  | {
      field_source: 'ethereum_transaction';
      field: 'value';
      operator: 'lte';
      value: string;
    };

interface WalletPolicyRule {
  name: string;
  method: 'eth_sendTransaction' | 'personal_sign';
  action: 'ALLOW';
  conditions: TransactionCondition[];
}

/** The body for `privy.policies().create(...)`. */
export interface WalletPolicy {
  version: '1.0';
  name: string;
  chain_type: 'ethereum';
  rules: WalletPolicyRule[];
}

// Compile-time proof that the body matches the SDK's create input.
type AssertAssignable<T extends U, U> = T;
export type WalletPolicyMatchesSdk = AssertAssignable<
  WalletPolicy,
  PrivyPoliciesService.CreateInput
>;

const DEFAULT_POLICY_NAME = 'Embedded wallet policy';

/**
 * Builds a Privy policy that allows only the listed contracts on the listed
 * chains, plus `personal_sign` when asked. Privy policies deny anything no
 * rule allows, so every allowed method needs its own rule.
 *
 * Each chain gets one rule whose conditions all must hold: the transaction's
 * `chain_id` is that chain, its `to` is one of that chain's contracts, and,
 * when `maxValue` has the chain, its `value` is at most that. Rules are
 * alternatives, so a contract allowed on one chain is not allowed on
 * another. Values are emitted as decimal strings (chain id, wei) and
 * checksummed addresses; the service sends checksummed `to` values to match.
 *
 * Not constrained: calldata. An allowed contract can be called with any
 * function and arguments, so allow only contracts whose every function is
 * safe for any signed-in user to call, and use the service's
 * `authorizeTransaction` hook to inspect calldata.
 */
export function buildWalletPolicy(options: WalletPolicyOptions): WalletPolicy {
  const rules: WalletPolicyRule[] = [];
  const maxValue = readMaxValue(options);

  for (const [key, addresses] of Object.entries(options.contracts)) {
    const chainId = Number(key);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new TypeError(`contracts has an invalid chain id: ${key}`);
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new TypeError(`contracts[${key}] must list at least one address.`);
    }
    const checksummed = addresses.map((address) => {
      if (typeof address !== 'string' || !isAddress(address)) {
        throw new TypeError(`contracts[${key}] has an invalid address.`);
      }
      return getAddress(address);
    });
    rules.push({
      name: `Allow contracts on chain ${chainId}`,
      method: 'eth_sendTransaction',
      action: 'ALLOW',
      conditions: [
        {
          field_source: 'ethereum_transaction',
          field: 'chain_id',
          operator: 'in',
          value: [String(chainId)],
        },
        {
          field_source: 'ethereum_transaction',
          field: 'to',
          operator: 'in',
          value: [...new Set(checksummed)],
        },
        ...(maxValue.has(chainId)
          ? [
              {
                field_source: 'ethereum_transaction',
                field: 'value',
                operator: 'lte',
                value: String(maxValue.get(chainId)),
              } as const,
            ]
          : []),
      ],
    });
  }

  if (options.allowPersonalSign) {
    // Unconditional by design: Privy policies cannot express which messages
    // are acceptable, so this allows signing any message.
    rules.push({
      name: 'Allow personal_sign',
      method: 'personal_sign',
      action: 'ALLOW',
      conditions: [],
    });
  }

  if (rules.length === 0) {
    throw new TypeError(
      'The policy would deny everything. Allow a contract or personal_sign.',
    );
  }

  return {
    version: '1.0',
    name: options.name ?? DEFAULT_POLICY_NAME,
    chain_type: 'ethereum',
    rules,
  };
}

function readMaxValue(options: WalletPolicyOptions): Map<number, bigint> {
  const result = new Map<number, bigint>();
  if (options.maxValue === undefined) return result;
  if (typeof options.maxValue !== 'object' || options.maxValue === null) {
    throw new TypeError('maxValue must be an object keyed by chain id.');
  }
  for (const [key, value] of Object.entries(options.maxValue)) {
    if (!Object.hasOwn(options.contracts, key)) {
      throw new TypeError(`maxValue[${key}] has no matching contracts entry.`);
    }
    if (typeof value !== 'bigint' || value < 0n) {
      throw new TypeError(`maxValue[${key}] must be a non-negative bigint.`);
    }
    result.set(Number(key), value);
  }
  return result;
}
