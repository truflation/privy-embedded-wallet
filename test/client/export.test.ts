import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddedWalletClient,
  EmbeddedWalletClientError,
  ERROR_CODE,
  exportPrivateKey,
  type ExportWalletRequest,
} from '../../src/client/index';
import { createRequestHandler } from '../../src/server/http/request-handler';
import { fromBase64, hpkeSeal } from '../hpke';
import { session, setup, TEST_JWT } from '../server/helpers';
import { errorResponse, jsonResponse } from './helpers';

const KEY = generatePrivateKey();
const ADDRESS = privateKeyToAddress(KEY);

/** A client whose server is Privy's own HPKE sender sealing `plaintext`. */
function sealingClient(plaintext: string = KEY) {
  const exportWallet = vi.fn(async (request: ExportWalletRequest) =>
    hpkeSeal(request.recipientPublicKey, plaintext),
  );
  return { exportWallet };
}

async function expectExportError(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EmbeddedWalletClientError);
  expect((error as EmbeddedWalletClientError).code).toBe(code);
  return error as EmbeddedWalletClientError;
}

describe('client.exportWallet', () => {
  it('POSTs to /wallet/export and returns the ciphertext fields', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ ciphertext: 'Y3Q=', encapsulatedKey: 'ZW5j' }),
    );
    const client = createEmbeddedWalletClient({
      basePath: '/api/wallets/embedded',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const request = { address: ADDRESS, recipientPublicKey: 'cGs=' };
    await expect(client.exportWallet(request)).resolves.toEqual({
      ciphertext: 'Y3Q=',
      encapsulatedKey: 'ZW5j',
    });
    const [url, init] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/wallets/embedded/wallet/export');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it('rejects a malformed response and passes server codes through', async () => {
    const malformed = createEmbeddedWalletClient({
      basePath: '/x',
      fetch: (async () => jsonResponse({ ciphertext: 1 })) as never,
    });
    await expectExportError(
      malformed.exportWallet({ address: ADDRESS, recipientPublicKey: 'cGs=' }),
      ERROR_CODE.PROVIDER_ERROR,
    );
    const denied = createEmbeddedWalletClient({
      basePath: '/x',
      fetch: (async () =>
        errorResponse(ERROR_CODE.POLICY_DENIED, 403)) as never,
    });
    await expectExportError(
      denied.exportWallet({ address: ADDRESS, recipientPublicKey: 'cGs=' }),
      ERROR_CODE.POLICY_DENIED,
    );
  });
});

describe('exportPrivateKey', () => {
  it('decrypts a key sealed by the Privy SDK sender to a fresh page key', async () => {
    const client = sealingClient();
    await expect(exportPrivateKey(client, { address: ADDRESS })).resolves.toBe(
      KEY,
    );

    const [request] = client.exportWallet.mock.calls[0]!;
    expect(Object.keys(request).sort()).toEqual([
      'address',
      'recipientPublicKey',
    ]);
    expect(request.address).toBe(ADDRESS);
    // Only the public half leaves the page: a 91-byte P-256 SPKI.
    expect(fromBase64(request.recipientPublicKey)).toHaveLength(91);

    await exportPrivateKey(client, { address: ADDRESS });
    const [second] = client.exportWallet.mock.calls[1]!;
    expect(second.recipientPublicKey).not.toBe(request.recipientPublicKey);
  });

  it('generates a non-extractable recipient private key', async () => {
    const generateKey = vi.spyOn(crypto.subtle, 'generateKey');
    await exportPrivateKey(sealingClient(), { address: ADDRESS });
    expect(generateKey).toHaveBeenCalledWith(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    generateKey.mockRestore();
  });

  it('normalizes a key sent without 0x or in upper case', async () => {
    const client = sealingClient(KEY.slice(2).toUpperCase());
    await expect(exportPrivateKey(client, { address: ADDRESS })).resolves.toBe(
      KEY,
    );
  });

  it('refuses a key that does not control the address', async () => {
    const client = sealingClient(generatePrivateKey());
    const error = await expectExportError(
      exportPrivateKey(client, { address: ADDRESS }),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(error.message).toMatch(/does not belong/);
  });

  it('refuses ciphertext it cannot open, and plaintext that is not a key', async () => {
    const tampered = {
      exportWallet: async (request: ExportWalletRequest) => {
        const sealed = await hpkeSeal(request.recipientPublicKey, KEY);
        const bytes = fromBase64(sealed.ciphertext);
        bytes[0] = bytes[0]! ^ 1;
        return {
          ...sealed,
          ciphertext: btoa(String.fromCharCode(...bytes)),
        };
      },
    };
    await expectExportError(
      exportPrivateKey(tampered, { address: ADDRESS }),
      ERROR_CODE.PROVIDER_ERROR,
    );

    const secret = 'abandon abandon abandon';
    const error = await expectExportError(
      exportPrivateKey(sealingClient(secret), { address: ADDRESS }),
      ERROR_CODE.PROVIDER_ERROR,
    );
    expect(error.message).not.toContain('abandon');
  });

  it('passes a server refusal through unchanged', async () => {
    const client = {
      exportWallet: async () => {
        throw new EmbeddedWalletClientError(
          ERROR_CODE.POLICY_DENIED,
          'denied',
          403,
        );
      },
    };
    await expectExportError(
      exportPrivateKey(client, { address: ADDRESS }),
      ERROR_CODE.POLICY_DENIED,
    );
  });

  it('works end to end through the request handler and service', async () => {
    const ctx = setup({ authorizeExport: () => true });
    const { address } = await ctx.service.ensureWallet(session);
    const wallet = ctx.fake.wallets.find(
      (w) => w.address === address.toLowerCase(),
    )!;
    const handle = createRequestHandler(ctx.service, {
      basePath: '/api/wallets/embedded',
      authenticate: () => session,
      allowedOrigins: ['https://app.example.com'],
    });
    const client = createEmbeddedWalletClient({
      basePath: '/api/wallets/embedded',
      headers: { Authorization: `Bearer ${TEST_JWT}` },
      fetch: ((input: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set('Origin', 'https://app.example.com');
        return handle(
          new Request(`https://app.example.com${input}`, { ...init, headers }),
        );
      }) as never,
    });
    await expect(exportPrivateKey(client, { address })).resolves.toBe(
      wallet.privateKey,
    );
  });
});
