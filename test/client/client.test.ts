import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddedWalletClient,
  EmbeddedWalletClientError,
  ERROR_CODE,
  type EmbeddedWalletClientOptions,
  type SendCallsRequest,
} from '../../src/client/index';
import { WALLET_ADDRESS, errorResponse, jsonResponse } from './helpers';

function setup(response: Response | (() => Response | Promise<Response>)) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    typeof response === 'function' ? response() : response.clone(),
  );
  const client = createEmbeddedWalletClient({
    basePath: '/api/wallets/embedded/',
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { fetch, client };
}

const lastCall = (fetch: ReturnType<typeof setup>['fetch']) => {
  const [url, init] = fetch.mock.calls.at(-1)!;
  return { url: String(url), init: init!, headers: new Headers(init!.headers) };
};

describe('createEmbeddedWalletClient', () => {
  it('getWallet reads GET /wallet with credentials', async () => {
    const { fetch, client } = setup(jsonResponse({ address: WALLET_ADDRESS }));
    await expect(client.getWallet()).resolves.toEqual({
      address: WALLET_ADDRESS,
    });
    const call = lastCall(fetch);
    expect(call.url).toBe('/api/wallets/embedded/wallet');
    expect(call.init.method).toBe('GET');
    expect(call.init.credentials).toBe('include');
  });

  it('getWallet returns null on 404 WALLET_NOT_FOUND', async () => {
    const { client } = setup(errorResponse(ERROR_CODE.WALLET_NOT_FOUND, 404));
    await expect(client.getWallet()).resolves.toBeNull();
  });

  it('getWallet still throws on other errors', async () => {
    const { client } = setup(errorResponse(ERROR_CODE.UNAUTHENTICATED, 401));
    await expect(client.getWallet()).rejects.toMatchObject({
      code: ERROR_CODE.UNAUTHENTICATED,
      status: 401,
    });
  });

  it('ensureWallet posts JSON', async () => {
    const { fetch, client } = setup(
      jsonResponse({ address: WALLET_ADDRESS, created: true }),
    );
    await expect(client.ensureWallet()).resolves.toEqual({
      address: WALLET_ADDRESS,
      created: true,
    });
    const call = lastCall(fetch);
    expect(call.init.method).toBe('POST');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.init.body).toBe('{}');
  });

  it('signMessage sends the address with strings and raw hex', async () => {
    const { fetch, client } = setup(jsonResponse({ signature: '0xdead' }));
    await expect(
      client.signMessage({ address: WALLET_ADDRESS, message: 'hi' }),
    ).resolves.toEqual({ signature: '0xdead' });
    expect(lastCall(fetch).url).toBe('/api/wallets/embedded/sign-message');
    expect(JSON.parse(lastCall(fetch).init.body as string)).toEqual({
      address: WALLET_ADDRESS,
      message: 'hi',
    });
    await client.signMessage({
      address: WALLET_ADDRESS,
      message: { raw: '0x1234' },
    });
    expect(JSON.parse(lastCall(fetch).init.body as string)).toEqual({
      address: WALLET_ADDRESS,
      message: { raw: '0x1234' },
    });
  });

  it('sendTransaction posts the request, requestId and from included', async () => {
    const { fetch, client } = setup(
      jsonResponse({ id: 't1', status: 'pending' }),
    );
    const request = {
      requestId: '7b0e7f0e-6f1c-4b8a-9d57-0d9d4a4e8c11',
      from: WALLET_ADDRESS,
      chainId: 1,
      to: WALLET_ADDRESS,
      value: '0x1',
    } as const;
    await expect(client.sendTransaction(request)).resolves.toEqual({
      id: 't1',
      status: 'pending',
    });
    expect(lastCall(fetch).url).toBe('/api/wallets/embedded/transactions');
    expect(JSON.parse(lastCall(fetch).init.body as string)).toEqual(request);
  });

  it('sendCalls posts the batch to /calls', async () => {
    const { fetch, client } = setup(
      jsonResponse({ id: 'b1', status: 'pending' }),
    );
    const request: SendCallsRequest = {
      requestId: '7b0e7f0e-6f1c-4b8a-9d57-0d9d4a4e8c11',
      from: WALLET_ADDRESS,
      chainId: 11155111,
      calls: [
        { to: WALLET_ADDRESS, data: '0x1234' },
        { to: WALLET_ADDRESS, value: '0x0' },
      ],
    };
    await expect(client.sendCalls(request)).resolves.toEqual({
      id: 'b1',
      status: 'pending',
    });
    const call = lastCall(fetch);
    expect(call.url).toBe('/api/wallets/embedded/calls');
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(call.init.body as string)).toEqual(request);
  });

  it('reads batchChainIds from the wallet, dropping anything malformed', async () => {
    await expect(
      setup(
        jsonResponse({ address: WALLET_ADDRESS, batchChainIds: [1, 11155111] }),
      ).client.getWallet(),
    ).resolves.toEqual({
      address: WALLET_ADDRESS,
      batchChainIds: [1, 11155111],
    });
    await expect(
      setup(
        jsonResponse({
          address: WALLET_ADDRESS,
          created: false,
          batchChainIds: [1, '0x1', -1, 1.5, null],
        }),
      ).client.ensureWallet(),
    ).resolves.toEqual({
      address: WALLET_ADDRESS,
      created: false,
      batchChainIds: [1],
    });
    await expect(
      setup(
        jsonResponse({ address: WALLET_ADDRESS, batchChainIds: 'all' }),
      ).client.getWallet(),
    ).resolves.toEqual({ address: WALLET_ADDRESS });
  });

  it('reads the chain id of a transaction when the server reports one', async () => {
    await expect(
      setup(
        jsonResponse({ id: 't', status: 'pending', chainId: 11155111 }),
      ).client.getTransaction('t'),
    ).resolves.toEqual({ id: 't', status: 'pending', chainId: 11155111 });
    await expect(
      setup(
        jsonResponse({ id: 't', status: 'pending', chainId: '0x1' }),
      ).client.getTransaction('t'),
    ).resolves.toEqual({ id: 't', status: 'pending' });
  });

  it('getTransaction encodes the id', async () => {
    const { fetch, client } = setup(
      jsonResponse({ id: 'a/b', status: 'confirmed', hash: '0xabc' }),
    );
    await expect(client.getTransaction('a/b')).resolves.toEqual({
      id: 'a/b',
      status: 'confirmed',
      hash: '0xabc',
    });
    expect(lastCall(fetch).url).toBe(
      '/api/wallets/embedded/transactions/a%2Fb',
    );
  });

  describe('headers option', () => {
    async function headersFor(headers: EmbeddedWalletClientOptions['headers']) {
      const fetch = vi.fn(async () =>
        jsonResponse({ address: WALLET_ADDRESS }),
      );
      const client = createEmbeddedWalletClient({
        basePath: '/x',
        fetch: fetch as unknown as typeof globalThis.fetch,
        headers,
      });
      await client.getWallet();
      const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
      return new Headers(init.headers);
    }

    it('accepts a plain object', async () => {
      const h = await headersFor({ Authorization: 'Bearer t' });
      expect(h.get('authorization')).toBe('Bearer t');
      expect(h.get('accept')).toBe('application/json');
    });

    it('drops undefined values from an object', async () => {
      const h = await headersFor({ Authorization: undefined, 'X-A': 'a' });
      expect(h.has('authorization')).toBe(false);
      expect(h.get('x-a')).toBe('a');
    });

    it('accepts a Headers instance and tuple arrays', async () => {
      const fromHeaders = await headersFor(new Headers({ 'X-B': 'b' }));
      expect(fromHeaders.get('x-b')).toBe('b');
      const fromTuples = await headersFor([['X-C', 'c']]);
      expect(fromTuples.get('x-c')).toBe('c');
    });

    it('accepts a callback returning an object, Headers or a promise', async () => {
      expect(
        (await headersFor(() => ({ Authorization: 'Bearer s' }))).get(
          'authorization',
        ),
      ).toBe('Bearer s');
      expect(
        (await headersFor(() => new Headers({ 'X-D': 'd' }))).get('x-d'),
      ).toBe('d');
      const h = await headersFor(async () => ({
        Authorization: undefined,
        'X-E': 'e',
      }));
      expect(h.has('authorization')).toBe(false);
      expect(h.get('x-e')).toBe('e');
    });

    it('calls the callback on every request', async () => {
      const callback = vi.fn(() => ({ 'X-N': 'n' }));
      const fetch = vi.fn(async () =>
        jsonResponse({ address: WALLET_ADDRESS }),
      );
      const client = createEmbeddedWalletClient({
        basePath: '/x',
        fetch: fetch as unknown as typeof globalThis.fetch,
        headers: callback,
      });
      await client.getWallet();
      await client.getWallet();
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    [ERROR_CODE.REAUTH_REQUIRED, 401],
    [ERROR_CODE.POLICY_DENIED, 403],
    [ERROR_CODE.CHAIN_NOT_SUPPORTED, 400],
    [ERROR_CODE.TRANSACTION_NOT_FOUND, 404],
  ])('maps %s to a typed error', async (code, status) => {
    const { client } = setup(errorResponse(code, status, 'nope'));
    const error = await client.ensureWallet().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddedWalletClientError);
    expect(error).toMatchObject({ code, status, message: 'nope' });
  });

  it('turns a non-JSON error body into PROVIDER_ERROR', async () => {
    const { client } = setup(
      new Response('<html>bad gateway</html>', { status: 502 }),
    );
    await expect(client.ensureWallet()).rejects.toMatchObject({
      code: ERROR_CODE.PROVIDER_ERROR,
      status: 502,
    });
  });

  it('turns an unknown error code into PROVIDER_ERROR', async () => {
    const { client } = setup(errorResponse('SOMETHING_ELSE', 500));
    await expect(client.ensureWallet()).rejects.toMatchObject({
      code: ERROR_CODE.PROVIDER_ERROR,
    });
  });

  it.each([
    ['wallet', () => jsonResponse({ address: 'nope' })],
    ['wallet', () => jsonResponse({})],
    ['wallet', () => new Response('not json', { status: 200 })],
  ])('rejects a malformed 2xx %s body as PROVIDER_ERROR', async (_n, make) => {
    const { client } = setup(make);
    await expect(client.ensureWallet()).rejects.toMatchObject({
      code: ERROR_CODE.PROVIDER_ERROR,
      status: 200,
    });
  });

  it('rejects malformed signature and transaction bodies', async () => {
    await expect(
      setup(jsonResponse({ signature: 5 })).client.signMessage({
        address: WALLET_ADDRESS,
        message: 'x',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODE.PROVIDER_ERROR });
    await expect(
      setup(jsonResponse({ id: 't', status: 'weird' })).client.getTransaction(
        't',
      ),
    ).rejects.toMatchObject({ code: ERROR_CODE.PROVIDER_ERROR });
    await expect(
      setup(
        jsonResponse({ id: 't', status: 'pending', hash: 'zz' }),
      ).client.getTransaction('t'),
    ).rejects.toMatchObject({ code: ERROR_CODE.PROVIDER_ERROR });
  });

  it('maps a network failure to PROVIDER_ERROR with status 0', async () => {
    const { client } = setup(() => {
      throw new TypeError('failed to fetch');
    });
    await expect(client.getWallet()).rejects.toMatchObject({
      code: ERROR_CODE.PROVIDER_ERROR,
      status: 0,
    });
  });
});
