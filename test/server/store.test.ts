import { describe, expect, it } from 'vitest';
import { createMemoryWalletStore } from '../../src/server/store';

const record = {
  userId: 'user-1',
  privyUserId: 'did:privy:1',
  walletId: 'wallet-1',
  address: '0x1111111111111111111111111111111111111111',
} as const;

describe('createMemoryWalletStore', () => {
  it('returns null for unknown users and upserts by userId', async () => {
    const store = createMemoryWalletStore();
    expect(await store.get('user-1')).toBeNull();
    await store.put(record);
    expect(await store.get('user-1')).toEqual(record);
    await store.put({ ...record, walletId: 'wallet-2' });
    expect((await store.get('user-1'))?.walletId).toBe('wallet-2');
  });

  it('returns copies so callers cannot mutate stored records', async () => {
    const store = createMemoryWalletStore();
    await store.put(record);
    const read = await store.get('user-1');
    read!.walletId = 'tampered';
    expect((await store.get('user-1'))?.walletId).toBe('wallet-1');
  });
});
