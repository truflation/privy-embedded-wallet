import { ref, type Ref } from 'vue';
import type { Address, WalletResponse } from '../protocol/index';

/**
 * The part of the client the composable needs. The `/client` entry's
 * `createEmbeddedWalletClient` result satisfies it.
 */
export interface EmbeddedWalletSource {
  getWallet(): Promise<WalletResponse | null>;
  ensureWallet(): Promise<WalletResponse>;
}

export type EmbeddedWalletStatus =
  'idle' | 'loading' | 'ready' | 'missing' | 'error';

export interface UseEmbeddedWallet {
  address: Ref<Address | null>;
  status: Ref<EmbeddedWalletStatus>;
  error: Ref<Error | null>;
  /** Looks the wallet up without creating it. */
  refresh(): Promise<void>;
  /** Finds or creates the wallet. */
  ensure(): Promise<void>;
}

/** Reactive wallet state. Does nothing until `refresh()` or `ensure()` is called. */
export function useEmbeddedWallet(
  client: EmbeddedWalletSource,
): UseEmbeddedWallet {
  const address = ref<Address | null>(null);
  const status = ref<EmbeddedWalletStatus>('idle');
  const error = ref<Error | null>(null);
  // Only the latest call may write state, so a slow earlier call cannot win.
  let latest = 0;

  async function run(load: () => Promise<WalletResponse | null>) {
    const call = ++latest;
    status.value = 'loading';
    error.value = null;
    try {
      const wallet = await load();
      if (call !== latest) return;
      address.value = wallet?.address ?? null;
      status.value = wallet ? 'ready' : 'missing';
    } catch (cause) {
      if (call !== latest) return;
      address.value = null;
      error.value = cause instanceof Error ? cause : new Error(String(cause));
      status.value = 'error';
    }
  }

  return {
    address,
    status,
    error,
    refresh: () => run(() => client.getWallet()),
    ensure: () => run(() => client.ensureWallet()),
  };
}
