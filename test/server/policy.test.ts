import { describe, expect, it } from 'vitest';
import { buildWalletPolicy } from '../../src/server/policy';

const LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER = '0x1111111111111111111111111111111111111111';

describe('buildWalletPolicy', () => {
  it('emits one rule per chain plus an explicit personal_sign rule', () => {
    const policy = buildWalletPolicy({
      contracts: { 1: [LOWER, OTHER], 560048: [OTHER] },
      allowPersonalSign: true,
      name: 'Test policy',
    });

    expect(policy).toEqual({
      version: '1.0',
      name: 'Test policy',
      chain_type: 'ethereum',
      rules: [
        {
          name: 'Allow contracts on chain 1',
          method: 'eth_sendTransaction',
          action: 'ALLOW',
          conditions: [
            {
              field_source: 'ethereum_transaction',
              field: 'chain_id',
              operator: 'in',
              value: ['1'],
            },
            {
              field_source: 'ethereum_transaction',
              field: 'to',
              operator: 'in',
              value: [CHECKSUMMED, OTHER],
            },
          ],
        },
        {
          name: 'Allow contracts on chain 560048',
          method: 'eth_sendTransaction',
          action: 'ALLOW',
          conditions: [
            {
              field_source: 'ethereum_transaction',
              field: 'chain_id',
              operator: 'in',
              value: ['560048'],
            },
            {
              field_source: 'ethereum_transaction',
              field: 'to',
              operator: 'in',
              value: [OTHER],
            },
          ],
        },
        {
          name: 'Allow personal_sign',
          method: 'personal_sign',
          action: 'ALLOW',
          conditions: [],
        },
      ],
    });
  });

  it('omits personal_sign when not allowed, so Privy denies it by default', () => {
    const policy = buildWalletPolicy({
      contracts: { 1: [OTHER] },
      allowPersonalSign: false,
    });
    expect(policy.rules.map((r) => r.method)).toEqual(['eth_sendTransaction']);
    expect(policy.name).toBe('Embedded wallet policy');
  });

  it('allows a sign-only policy', () => {
    const policy = buildWalletPolicy({
      contracts: {},
      allowPersonalSign: true,
    });
    expect(policy.rules).toHaveLength(1);
  });

  it('deduplicates addresses that differ only in case', () => {
    const policy = buildWalletPolicy({
      contracts: { 1: [LOWER, CHECKSUMMED] },
      allowPersonalSign: false,
    });
    expect(policy.rules[0]!.conditions[1]!.value).toEqual([CHECKSUMMED]);
  });

  it('adds a per-chain value ceiling as a decimal string', () => {
    const policy = buildWalletPolicy({
      contracts: { 1: [OTHER], 560048: [OTHER] },
      maxValue: { 1: 10n ** 18n },
      allowPersonalSign: false,
    });
    expect(policy.rules[0]!.conditions).toContainEqual({
      field_source: 'ethereum_transaction',
      field: 'value',
      operator: 'lte',
      value: '1000000000000000000',
    });
    // A chain without an entry gets no value condition.
    expect(policy.rules[1]!.conditions.map((c) => c.field)).toEqual([
      'chain_id',
      'to',
    ]);
  });

  it('rejects a value ceiling that is negative, not a bigint, or for an unlisted chain', () => {
    for (const maxValue of [{ 1: -1n }, { 1: 5 }, { 2: 1n }]) {
      expect(() =>
        buildWalletPolicy({
          contracts: { 1: [OTHER] },
          maxValue: maxValue as unknown as Record<number, bigint>,
          allowPersonalSign: false,
        }),
      ).toThrow(TypeError);
    }
  });

  it('rejects invalid input', () => {
    expect(() =>
      buildWalletPolicy({ contracts: {}, allowPersonalSign: false }),
    ).toThrow(TypeError);
    expect(() =>
      buildWalletPolicy({ contracts: { 1: [] }, allowPersonalSign: true }),
    ).toThrow(TypeError);
    expect(() =>
      buildWalletPolicy({
        contracts: { 1: ['0x123' as `0x${string}`] },
        allowPersonalSign: true,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildWalletPolicy({ contracts: { 0: [OTHER] }, allowPersonalSign: true }),
    ).toThrow(TypeError);
  });
});
