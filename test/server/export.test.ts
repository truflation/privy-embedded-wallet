import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_CODE,
  ROUTES,
  type Address,
  type ExportWalletResponse,
} from '../../src/protocol/index';
import { createRequestHandler } from '../../src/server/http/request-handler';
import type { ServiceOptions } from '../../src/server/service';
import { fromBase64, privyCryptography, toBase64 } from '../hpke';
import { upstream } from './fake-gateway';
import { expectCode, otherSession, session, setup, TEST_JWT } from './helpers';

const ORIGIN = 'https://app.example.com';
const BASE_PATH = '/api/wallets/embedded';

/** A browser-style recipient key pair: non-extractable private half. */
async function recipient() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey('spki', keyPair.publicKey),
  );
  return { keyPair, publicKey: toBase64(spki) };
}

async function open(keyPair: CryptoKeyPair, response: ExportWalletResponse) {
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  const context = await suite.createRecipientContext({
    recipientKey: keyPair,
    enc: fromBase64(response.encapsulatedKey),
  });
  return new TextDecoder().decode(
    await context.open(fromBase64(response.ciphertext)),
  );
}

async function withWallet(options: Partial<ServiceOptions> = {}) {
  const ctx = setup(options);
  const { address } = await ctx.service.ensureWallet(session);
  const wallet = ctx.fake.wallets.find(
    (w) => w.address === address.toLowerCase(),
  )!;
  return { ...ctx, address, wallet };
}

describe('exportWallet', () => {
  it('is refused with POLICY_DENIED when authorizeExport is not configured', async () => {
    const { service, address, fake, log } = await withWallet();
    const { publicKey } = await recipient();
    await expectCode(
      service.exportWallet(session, { address, recipientPublicKey: publicKey }),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.exportWallet).toHaveLength(0);
    expect(fake.calls.authorize).toHaveLength(0);
    expect(log.text()).toContain('authorizeExport is not configured');
  });

  it('returns ciphertext only the recipient can open, holding the wallet key', async () => {
    const authorizeExport = vi.fn(() => true);
    const { service, address, wallet, fake, log } = await withWallet({
      authorizeExport,
    });
    const { keyPair, publicKey } = await recipient();
    const response = await service.exportWallet(session, {
      address,
      recipientPublicKey: publicKey,
    });

    expect(Object.keys(response).sort()).toEqual([
      'ciphertext',
      'encapsulatedKey',
    ]);
    expect(await open(keyPair, response)).toBe(wallet.privateKey);
    expect(fake.calls.exportWallet).toEqual([
      { walletId: wallet.id, recipientPublicKey: publicKey },
    ]);
    expect(fake.calls.authorize).toContain(TEST_JWT);

    // A different key pair cannot open it.
    const other = await recipient();
    await expect(open(other.keyPair, response)).rejects.toThrow();

    // Neither the ciphertext nor the keys are logged; the export is.
    expect(log.text()).not.toContain(response.ciphertext);
    expect(log.text()).not.toContain(publicKey);
    expect(log.text()).not.toContain(wallet.privateKey.slice(2));
    expect(log.text()).toContain('Wallet private key exported');
  });

  it('passes the hook the session and the checksummed address, frozen', async () => {
    const authorizeExport = vi.fn(() => true);
    const { service, address } = await withWallet({ authorizeExport });
    const { publicKey } = await recipient();
    await service.exportWallet(session, {
      address: address.toLowerCase() as Address,
      recipientPublicKey: publicKey,
    });
    const [hookSession, input] = authorizeExport.mock.calls[0]! as unknown as [
      unknown,
      { address: string },
    ];
    expect(hookSession).toBe(session);
    expect(input).toEqual({ address: getAddress(address) });
    expect(Object.isFrozen(input)).toBe(true);
  });

  it.each([
    ['false', () => false],
    ['a truthy non-boolean', () => 'yes' as unknown as boolean],
    [
      'a throw',
      () => {
        throw new Error('step-up check failed');
      },
    ],
    ['a rejection', () => Promise.reject(new Error('no code'))],
  ])('denies on %s from authorizeExport', async (_, hook) => {
    const { service, address, fake } = await withWallet({
      authorizeExport: hook,
    });
    const { publicKey } = await recipient();
    await expectCode(
      service.exportWallet(session, { address, recipientPublicKey: publicKey }),
      ERROR_CODE.POLICY_DENIED,
    );
    expect(fake.calls.exportWallet).toHaveLength(0);
  });

  it('checks the session, wallet and account before the hook', async () => {
    const authorizeExport = vi.fn(() => true);
    const { service, address } = await withWallet({ authorizeExport });
    const { publicKey } = await recipient();
    const req = { address, recipientPublicKey: publicKey };

    await expectCode(
      service.exportWallet({ userId: 'user-1', jwt: otherSession.jwt }, req),
      ERROR_CODE.UNAUTHENTICATED,
    );
    await expectCode(
      service.exportWallet(otherSession, req),
      ERROR_CODE.WALLET_NOT_FOUND,
    );
    await expectCode(
      service.exportWallet(session, {
        ...req,
        address: '0x3333333333333333333333333333333333333333',
      }),
      ERROR_CODE.ACCOUNT_MISMATCH,
    );
    expect(authorizeExport).not.toHaveBeenCalled();
  });

  it('accepts the recipient key format the Privy SDK itself sends', async () => {
    // `setupHPKERecipient` is what `privy.wallets().exportPrivateKey()` uses;
    // its key is base64 encoded into `recipient_public_key` as is.
    const { service, address, wallet } = await withWallet({
      authorizeExport: () => true,
    });
    const sdkRecipient = await privyCryptography.setupHPKERecipient();
    const response = await service.exportWallet(session, {
      address,
      recipientPublicKey: toBase64(sdkRecipient.publicKeySpki),
    });
    const plaintext = await sdkRecipient.decryptPayload(
      fromBase64(response.encapsulatedKey),
      fromBase64(response.ciphertext),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(wallet.privateKey);
  });

  it('rejects recipient keys that are not a base64 P-256 SPKI', async () => {
    const { service, address, fake } = await withWallet({
      authorizeExport: () => true,
    });
    const { publicKey } = await recipient();
    const spki = fromBase64(publicKey);
    const compressedPrefix = spki.slice();
    compressedPrefix[26] = 0x02;
    const wrongCurve = spki.slice();
    wrongCurve[24] = 0x08;
    const bad: unknown[] = [
      undefined,
      123,
      '',
      'not base64!',
      publicKey.replace(/=+$/, ''), // unpadded
      `${publicKey.slice(0, 40)}-${publicKey.slice(41)}`, // base64url alphabet
      ` ${publicKey}`,
      toBase64(spki.subarray(26)), // raw 65-byte point
      toBase64(new Uint8Array([...spki, 0])),
      toBase64(spki.subarray(0, 90)),
      toBase64(compressedPrefix),
      toBase64(wrongCurve),
    ];
    for (const recipientPublicKey of bad) {
      await expectCode(
        service.exportWallet(session, {
          address,
          recipientPublicKey,
        } as never),
        ERROR_CODE.INVALID_REQUEST,
      );
    }
    await expectCode(
      service.exportWallet(session, {
        address,
        recipientPublicKey: publicKey,
        exportSeedPhrase: true,
      } as never),
      ERROR_CODE.INVALID_REQUEST,
    );
    expect(fake.calls.exportWallet).toHaveLength(0);
  });

  it('maps Privy failures like signing does', async () => {
    const { service, address, fake } = await withWallet({
      authorizeExport: () => true,
    });
    const { publicKey } = await recipient();
    const req = { address, recipientPublicKey: publicKey };

    fake.failWith('authorize', upstream('unauthorized', 401));
    await expectCode(
      service.exportWallet(session, req),
      ERROR_CODE.REAUTH_REQUIRED,
    );
    fake.clearFailures();
    fake.failWith('exportWallet', upstream('unauthorized', 401));
    await expectCode(
      service.exportWallet(session, req),
      ERROR_CODE.REAUTH_REQUIRED,
    );
    fake.failWith('exportWallet', upstream('unavailable', 500));
    await expectCode(
      service.exportWallet(session, req),
      ERROR_CODE.PROVIDER_ERROR,
    );
  });

  it('refuses a malformed Privy answer without logging it', async () => {
    const { service, address, fake, log } = await withWallet({
      authorizeExport: () => true,
    });
    const { publicKey } = await recipient();
    const good = await service.exportWallet(session, {
      address,
      recipientPublicKey: publicKey,
    });
    const answers = [
      { ...good, encryptionType: 'RSA' },
      { ...good, encapsulatedKey: 'not base64' },
      { ...good, encapsulatedKey: toBase64(new Uint8Array(33).fill(2)) },
      { ...good, ciphertext: toBase64(new Uint8Array(16)) },
      { ...good, ciphertext: toBase64(new Uint8Array(1025)) },
    ];
    for (const answer of answers) {
      vi.spyOn(fake.gateway, 'exportWallet').mockResolvedValueOnce({
        encryptionType: 'HPKE',
        ...answer,
      });
      await expectCode(
        service.exportWallet(session, {
          address,
          recipientPublicKey: publicKey,
        }),
        ERROR_CODE.PROVIDER_ERROR,
      );
    }
    expect(log.text()).toContain('malformed export response');
    expect(log.text()).not.toContain(good.ciphertext);
  });

  it('rejects an authorizeExport that is not a function', () => {
    expect(() => setup({ authorizeExport: 'yes' as never })).toThrow(
      /authorizeExport/,
    );
  });
});

describe('POST /wallet/export', () => {
  async function handlerWith(options: Partial<ServiceOptions>) {
    const ctx = await withWallet(options);
    const handle = createRequestHandler(ctx.service, {
      basePath: BASE_PATH,
      authenticate: (request) =>
        request.headers.get('Authorization') === `Bearer ${TEST_JWT}`
          ? session
          : null,
      allowedOrigins: [ORIGIN],
    });
    return { ...ctx, handle };
  }

  const post = (
    body: unknown,
    { origin = ORIGIN, contentType = 'application/json', method = 'POST' } = {},
  ) =>
    new Request(`${ORIGIN}${BASE_PATH}${ROUTES.WALLET_EXPORT}`, {
      method,
      headers: {
        Authorization: `Bearer ${TEST_JWT}`,
        ...(origin ? { Origin: origin } : {}),
        'Content-Type': contentType,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });

  it('serves the export with no-store', async () => {
    const { handle, address, wallet } = await handlerWith({
      authorizeExport: () => true,
    });
    const { keyPair, publicKey } = await recipient();
    const response = await handle(
      post({ address, recipientPublicKey: publicKey }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as ExportWalletResponse;
    expect(await open(keyPair, body)).toBe(wallet.privateKey);
  });

  it('returns 403 POLICY_DENIED by default', async () => {
    const { handle, address } = await handlerWith({});
    const { publicKey } = await recipient();
    const response = await handle(
      post({ address, recipientPublicKey: publicKey }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: ERROR_CODE.POLICY_DENIED },
    });
  });

  it('applies the origin, content-type, method and strict body rules', async () => {
    const { handle, address, fake } = await handlerWith({
      authorizeExport: () => true,
    });
    const { publicKey } = await recipient();
    const body = { address, recipientPublicKey: publicKey };

    expect(
      (await handle(post(body, { origin: 'https://evil.example' }))).status,
    ).toBe(403);
    expect((await handle(post(body, { origin: '' }))).status).toBe(403);
    expect(
      (await handle(post(body, { contentType: 'text/plain' }))).status,
    ).toBe(415);
    const get = await handle(post(undefined, { method: 'GET' }));
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
    expect((await handle(post({ ...body, extra: 1 }))).status).toBe(400);
    expect((await handle(post({ address }))).status).toBe(400);
    expect(fake.calls.exportWallet).toHaveLength(0);
  });
});
