import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmbeddedProvider,
  EmbeddedWalletClientError,
  ERROR_CODE,
} from '../../src/client/index';
import { WALLET_ADDRESS, createFakeClient } from './helpers';

function setup(
  client = createFakeClient(),
  extra: Partial<Parameters<typeof createEmbeddedProvider>[0]> = {},
) {
  const provider = createEmbeddedProvider({
    client,
    chainIds: [1, 11155111],
    pollingInterval: 100,
    transactionTimeout: 1_000,
    ...extra,
  });
  return { client, provider };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const rpcError = (code: number) => expect.objectContaining({ code });

describe('accounts and chain', () => {
  it('eth_accounts reads the wallet without creating it', async () => {
    const { client, provider } = setup();
    await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual(
      [WALLET_ADDRESS],
    );
    expect(client.ensureWallet).not.toHaveBeenCalled();
  });

  it('eth_accounts is empty when signed out or without a wallet', async () => {
    const signedOut = createFakeClient({
      getWallet: vi.fn(async () => {
        throw new EmbeddedWalletClientError(
          ERROR_CODE.UNAUTHENTICATED,
          'no',
          401,
        );
      }),
    });
    await expect(
      setup(signedOut).provider.request({ method: 'eth_accounts' }),
    ).resolves.toEqual([]);
    const missing = createFakeClient({ getWallet: vi.fn(async () => null) });
    await expect(
      setup(missing).provider.request({ method: 'eth_accounts' }),
    ).resolves.toEqual([]);
  });

  it('eth_requestAccounts ensures the wallet', async () => {
    const { client, provider } = setup();
    await expect(
      provider.request({ method: 'eth_requestAccounts' }),
    ).resolves.toEqual([WALLET_ADDRESS]);
    expect(client.ensureWallet).toHaveBeenCalledTimes(1);
  });

  it('eth_chainId returns a hex quantity of the initial chain', async () => {
    const { provider } = setup(undefined, { initialChainId: 11155111 });
    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe(
      '0xaa36a7',
    );
  });

  it('maps UNAUTHENTICATED and REAUTH_REQUIRED to 4100', async () => {
    for (const code of [
      ERROR_CODE.UNAUTHENTICATED,
      ERROR_CODE.REAUTH_REQUIRED,
    ]) {
      const client = createFakeClient({
        ensureWallet: vi.fn(async () => {
          throw new EmbeddedWalletClientError(code, 'x', 401);
        }),
      });
      await expect(
        setup(client).provider.request({ method: 'eth_requestAccounts' }),
      ).rejects.toEqual(rpcError(4100));
    }
  });
});

describe('personal_sign', () => {
  it('sends hex data as raw', async () => {
    const { client, provider } = setup();
    await expect(
      provider.request({
        method: 'personal_sign',
        params: ['0x68690a', WALLET_ADDRESS],
      }),
    ).resolves.toBe('0xsig');
    expect(client.signMessage).toHaveBeenCalledWith({
      address: WALLET_ADDRESS,
      message: { raw: '0x68690a' },
    });
  });

  it('sends plain strings as strings and ignores address case', async () => {
    const { client, provider } = setup();
    await provider.request({
      method: 'personal_sign',
      params: ['hello', WALLET_ADDRESS.toLowerCase()],
    });
    expect(client.signMessage).toHaveBeenCalledWith({
      address: WALLET_ADDRESS,
      message: 'hello',
    });
  });

  it('rejects another address with 4100 and does not sign', async () => {
    const { client, provider } = setup();
    await expect(
      provider.request({
        method: 'personal_sign',
        params: ['hi', '0x0000000000000000000000000000000000000001'],
      }),
    ).rejects.toEqual(rpcError(4100));
    expect(client.signMessage).not.toHaveBeenCalled();
  });

  it('rejects malformed params with -32602', async () => {
    await expect(
      setup().provider.request({ method: 'personal_sign', params: [1] }),
    ).rejects.toEqual(rpcError(-32602));
  });
});

describe('eth_sendTransaction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tx = {
    from: WALLET_ADDRESS,
    to: '0x0000000000000000000000000000000000000002',
    value: '0x10',
    data: '0x12',
  };

  it('returns the hash immediately when the submit has one', async () => {
    const { client, provider } = setup();
    await expect(
      provider.request({ method: 'eth_sendTransaction', params: [tx] }),
    ).resolves.toBe('0xabc');
    expect(client.sendTransaction).toHaveBeenCalledWith({
      requestId: expect.stringMatching(UUID),
      from: WALLET_ADDRESS,
      chainId: 1,
      to: tx.to,
      value: '0x10',
      data: '0x12',
    });
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('polls with backoff until a hash exists', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'pending' as const,
      })),
      getTransaction: vi
        .fn()
        .mockResolvedValueOnce({ id: 'tx-1', status: 'pending' })
        .mockResolvedValueOnce({ id: 'tx-1', status: 'pending' })
        .mockResolvedValueOnce({
          id: 'tx-1',
          status: 'pending',
          hash: '0xfeed',
        }),
    });
    const { provider } = setup(client);
    const result = provider.request({
      method: 'eth_sendTransaction',
      params: [tx],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(149); // backoff: 150ms next
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getTransaction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(225);
    await expect(result).resolves.toBe('0xfeed');
    expect(client.getTransaction).toHaveBeenCalledWith('tx-1');
  });

  it('rejects when polling sees a failed status', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'pending' as const,
      })),
      getTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'failed' as const,
      })),
    });
    const { provider } = setup(client);
    const result = provider.request({
      method: 'eth_sendTransaction',
      params: [tx],
    });
    const assertion = expect(result).rejects.toEqual(rpcError(-32000));
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('rejects when the submit itself reports failed', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'failed' as const,
      })),
    });
    await expect(
      setup(client).provider.request({
        method: 'eth_sendTransaction',
        params: [tx],
      }),
    ).rejects.toEqual(rpcError(-32000));
  });

  it('gives up after the timeout with a clear error', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'pending' as const,
      })),
      getTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'pending' as const,
      })),
    });
    const { provider } = setup(client);
    const result = provider.request({
      method: 'eth_sendTransaction',
      params: [tx],
    });
    const assertion = expect(result).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining('Timed out'),
      data: { id: 'tx-1', requestId: expect.stringMatching(UUID) },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('rejects a from address that is not the wallet', async () => {
    const { client, provider } = setup();
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ ...tx, from: '0x0000000000000000000000000000000000000001' }],
      }),
    ).rejects.toEqual(rpcError(4100));
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects missing to, bad data and mismatched chainId', async () => {
    const { provider } = setup();
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ value: '0x1' }],
      }),
    ).rejects.toEqual(rpcError(-32602));
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ ...tx, data: 'nope' }],
      }),
    ).rejects.toEqual(rpcError(-32602));
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ ...tx, chainId: '0x5' }],
      }),
    ).rejects.toEqual(rpcError(4901));
    await expect(
      provider.request({ method: 'eth_sendTransaction' }),
    ).rejects.toEqual(rpcError(-32602));
  });

  it('maps server errors onto RPC codes', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => {
        throw new EmbeddedWalletClientError(
          ERROR_CODE.POLICY_DENIED,
          'denied',
          403,
        );
      }),
    });
    await expect(
      setup(client).provider.request({
        method: 'eth_sendTransaction',
        params: [tx],
      }),
    ).rejects.toMatchObject({ code: -32003, message: 'denied' });
  });
});

describe('wallet_switchEthereumChain and unsupported methods', () => {
  it('switches to a configured chain, notifies, and emits chainChanged', async () => {
    const onChainChanged = vi.fn();
    const { provider } = setup(undefined, { onChainChanged });
    const listener = vi.fn();
    provider.on('chainChanged', listener);
    await expect(
      provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xaa36a7' }],
      }),
    ).resolves.toBeNull();
    expect(provider.chainId).toBe(11155111);
    expect(onChainChanged).toHaveBeenCalledWith(11155111);
    expect(listener).toHaveBeenCalledWith('0xaa36a7');
    provider.removeListener('chainChanged', listener);
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown chain with 4902 and keeps the chain', async () => {
    const { provider } = setup();
    await expect(
      provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x89' }],
      }),
    ).rejects.toEqual(rpcError(4902));
    expect(provider.chainId).toBe(1);
  });

  it('rejects unsupported methods with 4200', async () => {
    await expect(
      setup().provider.request({ method: 'eth_signTypedData_v4', params: [] }),
    ).rejects.toEqual(rpcError(4200));
  });
});

const TO = '0x0000000000000000000000000000000000000002';
const SEND = { from: WALLET_ADDRESS, to: TO, value: '0x10' };

const clientError = (code: string, status: number, message = code) =>
  new EmbeddedWalletClientError(code as never, message, status);

describe('idempotent sends', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Runs a send to completion, advancing timers across retry backoff. */
  async function finish(promise: Promise<unknown>) {
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    return settled;
  }

  it('retries a network failure with the same requestId and then succeeds', async () => {
    const sendTransaction = vi
      .fn()
      .mockRejectedValueOnce(clientError(ERROR_CODE.PROVIDER_ERROR, 0))
      .mockRejectedValueOnce(clientError(ERROR_CODE.PROVIDER_ERROR, 503))
      .mockResolvedValueOnce({ id: 'tx-1', status: 'pending', hash: '0xabc' });
    const { provider } = setup(createFakeClient({ sendTransaction }));
    const result = await finish(
      provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
    );
    expect(result).toEqual({ value: '0xabc' });
    expect(sendTransaction).toHaveBeenCalledTimes(3);
    const ids = sendTransaction.mock.calls.map(
      ([request]) => (request as { requestId: string }).requestId,
    );
    expect(ids[0]).toMatch(UUID);
    expect(new Set(ids).size).toBe(1);
  });

  it('retries an HTTP 5xx and a PROVIDER_ERROR code', async () => {
    for (const status of [500, 502, 400]) {
      const sendTransaction = vi
        .fn()
        .mockRejectedValueOnce(clientError(ERROR_CODE.PROVIDER_ERROR, status))
        .mockResolvedValueOnce({ id: 't', status: 'pending', hash: '0x1' });
      const { provider } = setup(createFakeClient({ sendTransaction }));
      const result = await finish(
        provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
      );
      expect(result).toEqual({ value: '0x1' });
      expect(sendTransaction).toHaveBeenCalledTimes(2);
    }
    const sendTransaction = vi
      .fn()
      .mockRejectedValueOnce(clientError('UNKNOWN_CODE', 500))
      .mockResolvedValueOnce({ id: 't', status: 'pending', hash: '0x1' });
    const { provider } = setup(createFakeClient({ sendTransaction }));
    expect(
      await finish(
        provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
      ),
    ).toEqual({ value: '0x1' });
  });

  it('gives up after two retries and reports the requestId', async () => {
    const sendTransaction = vi.fn(async () => {
      throw clientError(ERROR_CODE.PROVIDER_ERROR, 0, 'offline');
    });
    const { provider } = setup(createFakeClient({ sendTransaction }));
    const result = (await finish(
      provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
    )) as { error: { code: number; data: { requestId: string } } };
    expect(sendTransaction).toHaveBeenCalledTimes(3);
    expect(result.error).toMatchObject({ code: -32603, message: 'offline' });
    expect(result.error.data.requestId).toMatch(UUID);
    expect(result.error.data.requestId).toBe(
      (sendTransaction.mock.calls[0] as unknown as [{ requestId: string }])[0]
        .requestId,
    );
  });

  it.each([
    [ERROR_CODE.POLICY_DENIED, 403],
    [ERROR_CODE.INVALID_REQUEST, 400],
    [ERROR_CODE.INSUFFICIENT_FUNDS, 402],
    [ERROR_CODE.ACCOUNT_MISMATCH, 409],
    [ERROR_CODE.UNAUTHENTICATED, 401],
    [ERROR_CODE.REAUTH_REQUIRED, 401],
    [ERROR_CODE.CHAIN_NOT_SUPPORTED, 400],
  ])('does not retry the definite rejection %s', async (code, status) => {
    const sendTransaction = vi.fn(async () => {
      throw clientError(code, status);
    });
    const { provider } = setup(createFakeClient({ sendTransaction }));
    const result = await finish(
      provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
    );
    expect(result).toHaveProperty('error');
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('uses a new requestId for each call', async () => {
    const { client, provider } = setup();
    await provider.request({ method: 'eth_sendTransaction', params: [SEND] });
    await provider.request({ method: 'eth_sendTransaction', params: [SEND] });
    const [a, b] = client.sendTransaction.mock.calls.map(
      ([request]) => (request as { requestId: string }).requestId,
    );
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it('sends from as the wallet address even when the tx omits it', async () => {
    const { client, provider } = setup();
    await provider.request({
      method: 'eth_sendTransaction',
      params: [{ to: TO }],
    });
    expect(client.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ from: WALLET_ADDRESS }),
    );
  });

  it('the timeout error carries requestId and id', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-9',
        status: 'pending' as const,
      })),
      getTransaction: vi.fn(async () => ({
        id: 'tx-9',
        status: 'pending' as const,
      })),
    });
    const { provider } = setup(client);
    const result = (await finish(
      provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
    )) as { error: { data: { requestId: string; id: string } } };
    expect(result.error.data.id).toBe('tx-9');
    expect(result.error.data.requestId).toMatch(UUID);
  });
});

describe('failed transactions report their hash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('includes the hash from a failed poll response', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'pending' as const,
      })),
      getTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'failed' as const,
        hash: '0xdead' as const,
      })),
    });
    const { provider } = setup(client);
    const assertion = expect(
      provider.request({ method: 'eth_sendTransaction', params: [SEND] }),
    ).rejects.toMatchObject({
      code: -32000,
      data: {
        id: 'tx-1',
        hash: '0xdead',
        requestId: expect.stringMatching(UUID),
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('includes the hash when the submit itself reports failed', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'failed' as const,
        hash: '0xbeef' as const,
      })),
    });
    await expect(
      setup(client).provider.request({
        method: 'eth_sendTransaction',
        params: [SEND],
      }),
    ).rejects.toMatchObject({ code: -32000, data: { hash: '0xbeef' } });
  });

  it('omits the hash when there is none', async () => {
    const client = createFakeClient({
      sendTransaction: vi.fn(async () => ({
        id: 'tx-1',
        status: 'failed' as const,
      })),
    });
    const error = (await setup(client)
      .provider.request({ method: 'eth_sendTransaction', params: [SEND] })
      .catch((e: unknown) => e)) as { data: Record<string, unknown> };
    expect(error.data).not.toHaveProperty('hash');
  });
});

describe('account binding', () => {
  it.each([
    [ERROR_CODE.ACCOUNT_MISMATCH, 409],
    [ERROR_CODE.UNAUTHENTICATED, 401],
    [ERROR_CODE.REAUTH_REQUIRED, 401],
  ])(
    '%s clears the cached address and emits accountsChanged []',
    async (code, status) => {
      const signMessage = vi.fn(async () => {
        throw clientError(code, status);
      });
      const client = createFakeClient({ signMessage });
      const { provider } = setup(client);
      const listener = vi.fn();
      provider.on('accountsChanged', listener);

      await provider.request({ method: 'eth_accounts' });
      expect(client.getWallet).toHaveBeenCalledTimes(1);
      await provider.request({ method: 'eth_accounts' });
      expect(client.getWallet).toHaveBeenCalledTimes(1); // cached

      await expect(
        provider.request({
          method: 'personal_sign',
          params: ['hi', WALLET_ADDRESS],
        }),
      ).rejects.toEqual(rpcError(4100));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith([]);

      await provider.request({ method: 'eth_accounts' });
      expect(client.getWallet).toHaveBeenCalledTimes(2); // cache was cleared
    },
  );

  it('also triggers from a send and from a wallet lookup', async () => {
    const send = createFakeClient({
      sendTransaction: vi.fn(async () => {
        throw clientError(ERROR_CODE.ACCOUNT_MISMATCH, 409);
      }),
    });
    const a = setup(send).provider;
    const onSend = vi.fn();
    a.on('accountsChanged', onSend);
    await expect(
      a.request({ method: 'eth_sendTransaction', params: [SEND] }),
    ).rejects.toEqual(rpcError(4100));
    expect(onSend).toHaveBeenCalledWith([]);

    const lookup = createFakeClient({
      getWallet: vi.fn(async () => {
        throw clientError(ERROR_CODE.UNAUTHENTICATED, 401);
      }),
    });
    const b = setup(lookup).provider;
    const onLookup = vi.fn();
    b.on('accountsChanged', onLookup);
    await expect(b.request({ method: 'eth_accounts' })).resolves.toEqual([]);
    expect(onLookup).toHaveBeenCalledWith([]);
  });

  it('does not reset on other errors', async () => {
    const client = createFakeClient({
      signMessage: vi.fn(async () => {
        throw clientError(ERROR_CODE.POLICY_DENIED, 403);
      }),
    });
    const { provider } = setup(client);
    const listener = vi.fn();
    provider.on('accountsChanged', listener);
    await expect(
      provider.request({
        method: 'personal_sign',
        params: ['hi', WALLET_ADDRESS],
      }),
    ).rejects.toBeDefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('maps ACCOUNT_MISMATCH to 4100', async () => {
    const client = createFakeClient({
      ensureWallet: vi.fn(async () => {
        throw clientError(ERROR_CODE.ACCOUNT_MISMATCH, 409);
      }),
    });
    await expect(
      setup(client).provider.request({ method: 'eth_requestAccounts' }),
    ).rejects.toEqual(rpcError(4100));
  });
});

describe('eth_sendTransaction parameters', () => {
  const send = (tx: Record<string, unknown>, provider = setup()) =>
    provider.provider.request({
      method: 'eth_sendTransaction',
      params: [tx],
    });

  it('treats input as an alias of data', async () => {
    const s = setup();
    await send({ ...SEND, input: '0xAB12' }, s);
    expect(s.client.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ data: '0xAB12' }),
    );
    expect(s.client.sendTransaction.mock.calls[0]![0]).not.toHaveProperty(
      'input',
    );
  });

  it('accepts data and input when they agree, rejects when they differ', async () => {
    const s = setup();
    await send({ ...SEND, data: '0xab12', input: '0xAB12' }, s);
    expect(s.client.sendTransaction).toHaveBeenCalledTimes(1);
    await expect(
      send({ ...SEND, data: '0xab12', input: '0xab13' }),
    ).rejects.toEqual(rpcError(-32602));
  });

  it('rejects a non-hex input', async () => {
    await expect(send({ ...SEND, input: 'zz' })).rejects.toEqual(
      rpcError(-32602),
    );
  });

  it('ignores gas, fee and type fields and a matching chainId', async () => {
    const s = setup();
    await send(
      {
        ...SEND,
        gas: '0x5208',
        gasLimit: '0x5208',
        gasPrice: '0x1',
        maxFeePerGas: '0x2',
        maxPriorityFeePerGas: '0x1',
        type: '0x2',
        chainId: '0x1',
      },
      s,
    );
    expect(s.client.sendTransaction).toHaveBeenCalledWith({
      requestId: expect.stringMatching(UUID),
      from: WALLET_ADDRESS,
      chainId: 1,
      to: TO,
      value: '0x10',
    });
  });

  it.each([
    'nonce',
    'accessList',
    'authorizationList',
    'blobs',
    'blobVersionedHashes',
    'maxFeePerBlobGas',
    'somethingNew',
  ])('rejects %s with -32602 naming the field', async (field) => {
    const s = setup();
    await expect(send({ ...SEND, [field]: '0x1' }, s)).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining(`"${field}"`),
    });
    expect(s.client.sendTransaction).not.toHaveBeenCalled();
  });

  it('treats undefined-valued fields as absent', async () => {
    const s = setup();
    await send({ ...SEND, nonce: undefined, accessList: undefined }, s);
    expect(s.client.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
