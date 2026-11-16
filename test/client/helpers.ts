import { vi } from 'vitest';
import type { EmbeddedWalletClient } from '../../src/client/index';
import type {
  Address,
  Hex,
  TransactionResponse,
} from '../../src/protocol/index';

export const WALLET_ADDRESS: Address =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(code: string, status: number, message = code) {
  return jsonResponse({ error: { code, message } }, status);
}

export function createFakeClient(
  overrides: Partial<EmbeddedWalletClient> = {},
): {
  [K in keyof EmbeddedWalletClient]: ReturnType<typeof vi.fn>;
} & EmbeddedWalletClient {
  return {
    getWallet: vi.fn(async () => ({ address: WALLET_ADDRESS })),
    ensureWallet: vi.fn(async () => ({
      address: WALLET_ADDRESS,
      created: false,
    })),
    signMessage: vi.fn(async () => ({ signature: '0xsig' as Hex })),
    sendTransaction: vi.fn(async (): Promise<TransactionResponse> => ({
      id: 'tx-1',
      status: 'pending',
      hash: '0xabc',
    })),
    sendCalls: vi.fn(async (): Promise<TransactionResponse> => ({
      id: 'batch-1',
      status: 'pending',
    })),
    getTransaction: vi.fn(async (): Promise<TransactionResponse> => ({
      id: 'tx-1',
      status: 'pending',
      hash: '0xabc',
    })),
    ...overrides,
  } as never;
}

/** In-memory string storage for wagmi's `createStorage`. */
export function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}
