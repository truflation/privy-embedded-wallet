import { describe, expect, it } from 'vitest';
import {
  mapTransactionStatus,
  toTransactionHash,
} from '../../src/server/transaction-status';

describe('mapTransactionStatus', () => {
  it.each([
    ['pending', 'pending'],
    ['broadcasted', 'pending'],
    ['confirmed', 'confirmed'],
    ['finalized', 'confirmed'],
    ['execution_reverted', 'failed'],
    ['failed', 'failed'],
    ['provider_error', 'pending'],
    ['replaced', 'pending'],
  ])('maps %s to %s', (privy, expected) => {
    expect(mapTransactionStatus(privy)).toBe(expected);
  });

  it('maps an unknown status to pending, never failed', () => {
    expect(mapTransactionStatus('some_future_status')).toBe('pending');
    expect(mapTransactionStatus('__proto__')).toBe('pending');
  });
});

describe('toTransactionHash', () => {
  it('accepts a 32-byte hex hash only', () => {
    const hash = `0x${'0f'.repeat(32)}`;
    expect(toTransactionHash(hash)).toBe(hash);
    expect(toTransactionHash('')).toBeUndefined();
    expect(toTransactionHash(null)).toBeUndefined();
    expect(toTransactionHash('0x1234')).toBeUndefined();
    expect(toTransactionHash(`0x${'zz'.repeat(32)}`)).toBeUndefined();
  });
});
