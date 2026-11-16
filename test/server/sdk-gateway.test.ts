import { p256 } from '@noble/curves/nist';
import { sha256 } from '@noble/hashes/sha2';
import {
  PrivyClient,
  formatRequestForAuthorizationSignature,
  generateP256KeyPair,
} from '@privy-io/node';
import { bytesToHex, stringToBytes } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRIVY_API_URL,
  createSdkGateway,
} from '../../src/server/privy/sdk-gateway';
import { UpstreamError } from '../../src/server/privy/upstream-error';
import { TEST_JWT } from './helpers';

/**
 * Drives the real `@privy-io/node` client against a stubbed `fetch`, to pin
 * the request shapes the gateway produces.
 *
 * Wallet requests need the user's JWT exchanged for a signing key, and the
 * real exchange answers with an HPKE-encrypted key that a stub cannot produce
 * without an HPKE implementation. The SDK's exchange step is therefore
 * replaced with one that returns a locally generated P-256 key; everything
 * after it (authorization signature, headers, body, response parsing) is the
 * SDK's own code. The exchange request itself is covered by the integration
 * test.
 */

const API = 'https://privy.test';
const WALLET_ID = 'w1';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'cd'.repeat(65)}`;

interface Recorded {
  method: string;
  url: URL;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
}

let recorded: Recorded[];
let respond: (req: Recorded) => { status: number; body: unknown };

interface JwtExchange {
  exchangeJwtForAuthorizationKey(jwt: string): Promise<string>;
}

async function stubJwtExchange(
  keyPair?: Awaited<ReturnType<typeof generateP256KeyPair>>,
) {
  const { privateKey } = keyPair ?? (await generateP256KeyPair());
  const probe = new PrivyClient({
    appId: 'probe',
    appSecret: 'probe',
    apiUrl: API,
  });
  const exchange = (
    probe as unknown as { _jwtExchange(): JwtExchange }
  )._jwtExchange();
  const prototype = Object.getPrototypeOf(exchange) as JwtExchange;
  return vi
    .spyOn(prototype, 'exchangeJwtForAuthorizationKey')
    .mockResolvedValue(privateKey);
}

beforeEach(() => {
  recorded = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const text = typeof init?.body === 'string' ? init.body : '';
      const req: Recorded = {
        method: init?.method ?? 'GET',
        url,
        path: url.pathname,
        search: url.search,
        headers: new Headers(init?.headers),
        body: text ? JSON.parse(text) : undefined,
      };
      recorded.push(req);
      const { status, body } = respond(req);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const gateway = () =>
  createSdkGateway({ appId: 'app-id', appSecret: 'app-secret', apiUrl: API });

const wallet = (id: string, createdAt: number, policyIds: string[] = []) => ({
  id,
  address: '0x1111111111111111111111111111111111111111',
  chain_type: 'ethereum',
  created_at: createdAt,
  exported_at: null,
  imported_at: null,
  owner_id: null,
  policy_ids: policyIds,
  additional_signers: [],
});

describe('sdk gateway', () => {
  it('returns null when the custom auth user does not exist', async () => {
    respond = () => ({ status: 404, body: { error: 'User not found' } });
    expect(await gateway().findUserByCustomAuthId('user-1')).toBeNull();
    expect(recorded[0]).toMatchObject({
      method: 'POST',
      path: '/v1/users/custom_auth/id',
      body: { custom_user_id: 'user-1' },
    });
  });

  it('creates a user with a custom_auth linked account', async () => {
    respond = () => ({ status: 200, body: { id: 'did:privy:1' } });
    expect(await gateway().createUser('user-1')).toEqual({ id: 'did:privy:1' });
    expect(recorded[0]).toMatchObject({
      method: 'POST',
      path: '/v1/users',
      body: {
        linked_accounts: [{ type: 'custom_auth', custom_user_id: 'user-1' }],
      },
    });
  });

  it('lists the user wallets across pages, with their policies', async () => {
    respond = (req) =>
      req.search.includes('cursor=page2')
        ? {
            status: 200,
            body: { data: [wallet('w2', 2, ['p1'])], next_cursor: null },
          }
        : {
            status: 200,
            body: { data: [wallet('w1', 1)], next_cursor: 'page2' },
          };
    const wallets = await gateway().listUserWallets('did:privy:1');
    expect(wallets.map((w) => [w.id, w.policyIds])).toEqual([
      ['w1', []],
      ['w2', ['p1']],
    ]);
    expect(recorded[0]!.path).toBe('/v1/wallets');
    expect(recorded[0]!.search).toContain('user_id=did%3Aprivy%3A1');
    expect(recorded[0]!.search).toContain('chain_type=ethereum');
  });

  it('creates a user-owned wallet with policy and idempotency key', async () => {
    respond = () => ({ status: 200, body: wallet('w1', 1, ['policy-1']) });
    const created = await gateway().createUserWallet({
      privyUserId: 'did:privy:1',
      policyIds: ['policy-1'],
      idempotencyKey: 'key-1',
    });
    expect(created).toEqual({
      id: 'w1',
      address: '0x1111111111111111111111111111111111111111',
      createdAt: 1,
      policyIds: ['policy-1'],
    });
    expect(recorded[0]).toMatchObject({
      method: 'POST',
      path: '/v1/wallets',
      body: {
        chain_type: 'ethereum',
        owner: { user_id: 'did:privy:1' },
        policy_ids: ['policy-1'],
      },
    });
    expect(recorded[0]!.headers.get('privy-idempotency-key')).toBe('key-1');
  });

  it('omits policy_ids when none are configured', async () => {
    respond = () => ({ status: 200, body: wallet('w1', 1) });
    await gateway().createUserWallet({
      privyUserId: 'did:privy:1',
      policyIds: [],
      idempotencyKey: 'key-1',
    });
    expect(recorded[0]!.body).not.toHaveProperty('policy_ids');
  });

  it('reads a transaction, including its wallet id', async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 'tx1',
        wallet_id: 'w1',
        status: 'broadcasted',
        transaction_hash: null,
        caip2: 'eip155:11155111',
        created_at: 1,
      },
    });
    expect(await gateway().getTransaction('tx1')).toEqual({
      id: 'tx1',
      walletId: 'w1',
      status: 'broadcasted',
      hash: null,
    });
    expect(recorded[0]).toMatchObject({
      method: 'GET',
      path: '/v1/transactions/tx1',
    });
  });

  it('normalizes SDK errors into UpstreamError', async () => {
    respond = () => ({ status: 401, body: { error: 'Invalid app secret' } });
    const error = await gateway()
      .createUser('user-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ kind: 'unauthorized', status: 401 });
  });
});

describe('sdk gateway wallet requests', () => {
  const rpcResponse = (method: string, data: unknown) => ({
    status: 200,
    body: { method, data },
  });
  const TO = '0x1111111111111111111111111111111111111111';

  it('exchanges the JWT without sending anything for authorize', async () => {
    const exchange = await stubJwtExchange();
    respond = () => ({ status: 500, body: {} });
    await gateway().authorize(TEST_JWT);
    expect(exchange.mock.calls[0]![0]).toBe(TEST_JWT);
    expect(recorded).toHaveLength(0);
  });

  it('signs UTF-8 text as its bytes, hex encoded, even when it looks like hex', async () => {
    const exchange = await stubJwtExchange();
    respond = () =>
      rpcResponse('personal_sign', { signature: SIGNATURE, encoding: 'hex' });

    const text = '0xabcd';
    const signature = await gateway().signMessage(
      WALLET_ID,
      stringToBytes(text),
      TEST_JWT,
    );

    expect(signature).toBe(SIGNATURE);
    expect(exchange.mock.calls[0]![0]).toBe(TEST_JWT);
    const [req] = recorded;
    expect(req).toMatchObject({
      method: 'POST',
      path: `/v1/wallets/${WALLET_ID}/rpc`,
      body: {
        method: 'personal_sign',
        chain_type: 'ethereum',
        params: {
          // The UTF-8 bytes of "0xabcd", not the two bytes 0xab 0xcd.
          message: bytesToHex(stringToBytes(text)).slice(2),
          encoding: 'hex',
        },
      },
    });
    expect(req!.headers.get('privy-authorization-signature')).toBeTruthy();
    expect(req!.headers.get('privy-app-id')).toBe('app-id');
    expect(JSON.stringify(req!.body)).not.toContain(TEST_JWT);
  });

  it('signs raw bytes as hex', async () => {
    await stubJwtExchange();
    respond = () =>
      rpcResponse('personal_sign', { signature: SIGNATURE, encoding: 'hex' });
    await gateway().signMessage(
      WALLET_ID,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      TEST_JWT,
    );
    expect(recorded[0]!.body).toMatchObject({
      params: { message: 'deadbeef', encoding: 'hex' },
    });
  });

  it('sends a sponsored transaction with caip2, reference_id and the idempotency header', async () => {
    await stubJwtExchange();
    respond = () =>
      rpcResponse('eth_sendTransaction', {
        caip2: 'eip155:11155111',
        hash: TX_HASH,
        transaction_id: 'tx1',
        reference_id: 'ref-1',
      });

    const sent = await gateway().sendTransaction(
      WALLET_ID,
      {
        chainId: 11155111,
        sponsor: true,
        to: TO,
        data: '0x1234',
        value: '0x1',
        idempotencyKey: 'idem-1',
        referenceId: 'ref-1',
      },
      TEST_JWT,
    );

    expect(sent).toEqual({ hash: TX_HASH, transactionId: 'tx1' });
    const [req] = recorded;
    expect(req!.path).toBe(`/v1/wallets/${WALLET_ID}/rpc`);
    expect(req!.body).toEqual({
      method: 'eth_sendTransaction',
      chain_type: 'ethereum',
      caip2: 'eip155:11155111',
      sponsor: true,
      reference_id: 'ref-1',
      params: {
        transaction: {
          chain_id: 11155111,
          to: TO,
          data: '0x1234',
          value: '0x1',
        },
      },
    });
    expect(req!.headers.get('privy-idempotency-key')).toBe('idem-1');
    expect(req!.headers.get('privy-authorization-signature')).toBeTruthy();
  });

  it('omits sponsor, data and value when not given', async () => {
    await stubJwtExchange();
    respond = () =>
      rpcResponse('eth_sendTransaction', {
        caip2: 'eip155:560048',
        hash: '',
        transaction_id: 'tx2',
      });
    const sent = await gateway().sendTransaction(
      WALLET_ID,
      {
        chainId: 560048,
        sponsor: false,
        to: TO,
        idempotencyKey: 'idem-2',
        referenceId: 'ref-2',
      },
      TEST_JWT,
    );
    expect(sent).toEqual({ hash: '', transactionId: 'tx2' });
    const body = recorded[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('sponsor');
    expect(body.caip2).toBe('eip155:560048');
    expect(body.reference_id).toBe('ref-2');
    expect(body.params).toEqual({
      transaction: { chain_id: 560048, to: TO },
    });
  });

  it('keeps the same idempotency key on SDK-level retries', async () => {
    await stubJwtExchange();
    let attempts = 0;
    respond = () => {
      attempts++;
      return attempts === 1
        ? { status: 503, body: { error: 'unavailable' } }
        : rpcResponse('eth_sendTransaction', {
            caip2: 'eip155:11155111',
            hash: TX_HASH,
            transaction_id: 'tx1',
          });
    };
    await gateway().sendTransaction(
      WALLET_ID,
      {
        chainId: 11155111,
        sponsor: false,
        to: TO,
        idempotencyKey: 'idem-3',
        referenceId: 'ref-3',
      },
      TEST_JWT,
    );
    expect(recorded).toHaveLength(2);
    expect(recorded.map((r) => r.headers.get('privy-idempotency-key'))).toEqual(
      ['idem-3', 'idem-3'],
    );
  }, 10_000);

  it('updates wallet policies with the user JWT as authorization', async () => {
    await stubJwtExchange();
    respond = () => ({
      status: 200,
      body: wallet(WALLET_ID, 1, ['policy-1']),
    });
    const updated = await gateway().updateWalletPolicies(
      WALLET_ID,
      ['policy-1'],
      TEST_JWT,
    );
    expect(updated.policyIds).toEqual(['policy-1']);
    expect(recorded[0]).toMatchObject({
      method: 'PATCH',
      path: `/v1/wallets/${WALLET_ID}`,
      body: { policy_ids: ['policy-1'] },
    });
    expect(
      recorded[0]!.headers.get('privy-authorization-signature'),
    ).toBeTruthy();
  });
});

describe('sdk gateway export', () => {
  // A base64 P-256 SPKI, as the browser sends it. Never decrypted here.
  const RECIPIENT = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${'A'.repeat(86)}==`;
  const EXPORTED = {
    ciphertext: 'Y2lwaGVydGV4dA==',
    encapsulated_key:
      'BOhR6xITDt5THJawHHJKrKdI9CBr2M/SDWzZZAaOW4gCMsSpC65U007WyKiwuuOVAo1BNm4YgcBBROuMmyIZXZk=',
    encryption_type: 'HPKE',
  };

  it('requests HPKE export to the given key, signed with the user key, and returns ciphertext', async () => {
    const keyPair = await generateP256KeyPair();
    const exchange = await stubJwtExchange(keyPair);
    respond = () => ({ status: 200, body: EXPORTED });

    const exported = await gateway().exportWallet(
      WALLET_ID,
      RECIPIENT,
      TEST_JWT,
    );

    expect(exported).toEqual({
      ciphertext: EXPORTED.ciphertext,
      encapsulatedKey: EXPORTED.encapsulated_key,
      encryptionType: 'HPKE',
    });
    expect(exchange.mock.calls[0]![0]).toBe(TEST_JWT);
    expect(recorded).toHaveLength(1);
    const [req] = recorded;
    expect(req!.method).toBe('POST');
    expect(req!.path).toBe(`/v1/wallets/${WALLET_ID}/export`);
    // The body the SDK's own `exportPrivateKey` sends, with our key.
    expect(req!.body).toEqual({
      encryption_type: 'HPKE',
      recipient_public_key: RECIPIENT,
      export_seed_phrase: false,
    });
    expect(JSON.stringify(req!.body)).not.toContain(TEST_JWT);

    // The signature covers exactly the request that was sent, in the form
    // Privy verifies (`formatRequestForAuthorizationSignature`).
    const expiry = req!.headers.get('privy-request-expiry');
    expect(Number(expiry)).toBeGreaterThan(Date.now());
    const payload = formatRequestForAuthorizationSignature({
      version: 1,
      method: 'POST',
      url: req!.url.href,
      body: req!.body as Record<string, unknown>,
      headers: { 'privy-app-id': 'app-id', 'privy-request-expiry': expiry! },
    });
    const signature = Uint8Array.from(
      atob(req!.headers.get('privy-authorization-signature')!),
      (c) => c.charCodeAt(0),
    );
    const publicKey = Uint8Array.from(atob(keyPair.publicKey), (c) =>
      c.charCodeAt(0),
    ).subarray(26);
    expect(
      p256.verify(
        p256.Signature.fromDER(signature).toCompactRawBytes(),
        sha256(payload),
        publicKey,
      ),
    ).toBe(true);
  });

  it('normalizes export failures into UpstreamError', async () => {
    await stubJwtExchange();
    respond = () => ({ status: 401, body: { error: 'invalid jwt' } });
    const error = await gateway()
      .exportWallet(WALLET_ID, RECIPIENT, TEST_JWT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({
      operation: 'wallets.export',
      kind: 'unauthorized',
    });
  });
});

describe('sdk client hardening (rule 10)', () => {
  it('ignores PRIVY_API_BASE_URL and PRIVY_API_LOG', async () => {
    vi.stubEnv('PRIVY_API_BASE_URL', 'https://attacker.test');
    vi.stubEnv('PRIVY_API_LOG', 'debug');
    const consoleCalls = (
      ['debug', 'info', 'log', 'warn', 'error'] as const
    ).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    respond = () => ({ status: 200, body: { id: 'did:privy:1' } });

    // No apiUrl: the production default applies.
    const production = createSdkGateway({
      appId: 'app-id',
      appSecret: 'app-secret',
    });
    await production.createUser('user-1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url.origin).toBe(PRIVY_API_URL);
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
  });

  it('shows the env vars do change an SDK client built without these options', async () => {
    // Guards the test above: if the SDK stopped reading these variables,
    // that test would pass vacuously.
    vi.stubEnv('PRIVY_API_BASE_URL', 'https://attacker.test');
    vi.stubEnv('PRIVY_API_LOG', 'debug');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    respond = () => ({ status: 200, body: { id: 'did:privy:1' } });
    const unhardened = new PrivyClient({ appId: 'app-id', appSecret: 'x' });
    await unhardened.users().create({ linked_accounts: [] });
    expect(recorded[0]!.url.origin).toBe('https://attacker.test');
    expect(debug).toHaveBeenCalled();
  });

  it('pins the production URL the SDK itself defaults to', () => {
    expect(PRIVY_API_URL).toBe('https://api.privy.io');
  });
});
