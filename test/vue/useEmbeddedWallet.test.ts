import { describe, expect, it, vi } from 'vitest';
import { useEmbeddedWallet } from '../../src/vue/index';

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

function source(overrides = {}) {
  return {
    getWallet: vi.fn(async () => ({ address: ADDRESS })),
    ensureWallet: vi.fn(async () => ({ address: ADDRESS, created: true })),
    ...overrides,
  };
}

describe('useEmbeddedWallet', () => {
  it('does nothing until called', () => {
    const client = source();
    const wallet = useEmbeddedWallet(client);
    expect(wallet.status.value).toBe('idle');
    expect(wallet.address.value).toBeNull();
    expect(client.getWallet).not.toHaveBeenCalled();
    expect(client.ensureWallet).not.toHaveBeenCalled();
  });

  it('refresh goes loading then ready', async () => {
    const wallet = useEmbeddedWallet(source());
    const pending = wallet.refresh();
    expect(wallet.status.value).toBe('loading');
    await pending;
    expect(wallet.status.value).toBe('ready');
    expect(wallet.address.value).toBe(ADDRESS);
    expect(wallet.error.value).toBeNull();
  });

  it('refresh reports missing without creating', async () => {
    const client = source({ getWallet: vi.fn(async () => null) });
    const wallet = useEmbeddedWallet(client);
    await wallet.refresh();
    expect(wallet.status.value).toBe('missing');
    expect(wallet.address.value).toBeNull();
    expect(client.ensureWallet).not.toHaveBeenCalled();
  });

  it('ensure creates the wallet and moves missing to ready', async () => {
    const client = source({ getWallet: vi.fn(async () => null) });
    const wallet = useEmbeddedWallet(client);
    await wallet.refresh();
    await wallet.ensure();
    expect(wallet.status.value).toBe('ready');
    expect(wallet.address.value).toBe(ADDRESS);
  });

  it('records errors, then recovers on the next success', async () => {
    const getWallet = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ address: ADDRESS });
    const wallet = useEmbeddedWallet(source({ getWallet }));
    await wallet.refresh();
    expect(wallet.status.value).toBe('error');
    expect(wallet.error.value?.message).toBe('down');
    await wallet.refresh();
    expect(wallet.status.value).toBe('ready');
    expect(wallet.error.value).toBeNull();
  });

  it('wraps non-Error rejections', async () => {
    const wallet = useEmbeddedWallet(
      source({ getWallet: vi.fn().mockRejectedValue('nope') }),
    );
    await wallet.refresh();
    expect(wallet.error.value).toBeInstanceOf(Error);
  });

  it('ignores a stale call that finishes after a newer one', async () => {
    let releaseSlow!: (v: null) => void;
    const getWallet = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (releaseSlow = resolve)));
    const wallet = useEmbeddedWallet(source({ getWallet }));
    const slow = wallet.refresh();
    await wallet.ensure();
    releaseSlow(null);
    await slow;
    expect(wallet.status.value).toBe('ready');
    expect(wallet.address.value).toBe(ADDRESS);
  });
});
