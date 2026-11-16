import { createWalletClient, custom, type Chain, type Hex } from 'viem';
import {
  getCallsStatus,
  getCapabilities,
  sendCalls,
  waitForCallsStatus,
} from 'viem/actions';
import { mainnet, sepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmbeddedProvider,
  EmbeddedWalletClientError,
  ERROR_CODE,
  MAX_BATCH_CALLS,
  type TransactionResponse,
} from '../../src/client/index';
import { WALLET_ADDRESS, createFakeClient } from './helpers';

/**
 * EIP-5792 on the provider, driven through viem's own actions (the ones
 * wagmi's `sendCalls`, `getCallsStatus`, `waitForCallsStatus` and
 * `getCapabilities` call), so the shapes are checked against the spec
 * version viem implements.
 */

const SEPOLIA = sepolia.id;
const TO = '0x0000000000000000000000000000000000000002';
const HASH: Hex = `0x${'ab'.repeat(32)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RECEIPT = {
  blockHash: `0x${'cd'.repeat(32)}`,
  blockNumber: '0x10',
  contractAddress: null,
  cumulativeGasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  from: WALLET_ADDRESS,
  gasUsed: '0x5208',
  logs: [
    {
      address: TO,
      data: '0x',
      topics: [`0x${'ef'.repeat(32)}`],
      blockNumber: '0x10',
      logIndex: '0x0',
    },
  ],
  logsBloom: '0x00',
  status: '0x1',
  to: TO,
  transactionHash: HASH,
  transactionIndex: '0x0',
  type: '0x2',
};

const clientError = (code: string, status: number, message = code) =>
  new EmbeddedWalletClientError(code as never, message, status);

const rpcError = (code: number) => expect.objectContaining({ code });

/**
 * viem wraps provider errors (for example in `TransactionExecutionError`),
 * so the provider's code is found by walking the cause chain.
 */
async function expectRpcCode(promise: Promise<unknown>, code: number) {
  let error: unknown = await promise.then(
    () => {
      throw new Error(`expected ${code}, but it resolved`);
    },
    (e: unknown) => e,
  );
  while (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code !== 'number'
  ) {
    error = error.cause;
  }
  expect((error as { code?: unknown } | undefined)?.code).toBe(code);
}

/** A fake client whose wallet batches on Sepolia only. */
function batchingClient(
  overrides: Parameters<typeof createFakeClient>[0] = {},
) {
  return createFakeClient({
    getWallet: vi.fn(async () => ({
      address: WALLET_ADDRESS,
      batchChainIds: [SEPOLIA],
    })),
    ...overrides,
  });
}

function setup(
  client = batchingClient(),
  extra: Partial<Parameters<typeof createEmbeddedProvider>[0]> = {},
) {
  const provider = createEmbeddedProvider({
    client,
    chainIds: [mainnet.id, SEPOLIA],
    initialChainId: SEPOLIA,
    pollingInterval: 10,
    transactionTimeout: 1_000,
    ...extra,
  });
  const wallet = (chain: Chain = sepolia) =>
    createWalletClient({
      account: WALLET_ADDRESS,
      chain,
      transport: custom(provider),
      pollingInterval: 10,
    });
  return { client, provider, wallet };
}

const CALLS = [
  { to: TO, data: '0x095ea7b3' as Hex },
  { to: TO, value: 1n },
] as const;

describe('wallet_getCapabilities', () => {
  it('reports atomic supported exactly on the chains the server batches on', async () => {
    const { wallet } = setup();
    await expect(getCapabilities(wallet())).resolves.toEqual({
      [mainnet.id]: { atomic: { status: 'unsupported' } },
      [SEPOLIA]: { atomic: { status: 'supported' } },
    });
    await expect(
      getCapabilities(wallet(), { chainId: SEPOLIA }),
    ).resolves.toEqual({ atomic: { status: 'supported' } });
  });

  it('returns the raw EIP-5792 shape keyed by hex chain id', async () => {
    const { provider } = setup();
    await expect(
      provider.request({
        method: 'wallet_getCapabilities',
        params: [WALLET_ADDRESS, ['0xaa36a7', '0x5']],
      }),
    ).resolves.toEqual({ '0xaa36a7': { atomic: { status: 'supported' } } });
  });

  it('reports nothing as supported for a server older than 0.2.0', async () => {
    const { wallet } = setup(createFakeClient());
    await expect(getCapabilities(wallet())).resolves.toEqual({
      [mainnet.id]: { atomic: { status: 'unsupported' } },
      [SEPOLIA]: { atomic: { status: 'unsupported' } },
    });
  });

  it('learns the chains from ensureWallet too', async () => {
    const client = createFakeClient({
      getWallet: vi.fn(async () => null),
      ensureWallet: vi.fn(async () => ({
        address: WALLET_ADDRESS,
        created: false,
        batchChainIds: [SEPOLIA],
      })),
    });
    const { provider } = setup(client);
    await provider.request({ method: 'eth_requestAccounts' });
    await expect(
      provider.request({ method: 'wallet_getCapabilities', params: [] }),
    ).resolves.toMatchObject({
      '0xaa36a7': { atomic: { status: 'supported' } },
    });
  });

  it('refuses another address with 4100 and malformed chain ids with -32602', async () => {
    const { provider } = setup();
    await expect(
      provider.request({
        method: 'wallet_getCapabilities',
        params: ['0x0000000000000000000000000000000000000001'],
      }),
    ).rejects.toEqual(rpcError(4100));
    await expect(
      provider.request({
        method: 'wallet_getCapabilities',
        params: [WALLET_ADDRESS, ['sepolia']],
      }),
    ).rejects.toEqual(rpcError(-32602));
  });

  it('fails with 4100 when there is no wallet', async () => {
    const { provider } = setup(
      createFakeClient({ getWallet: vi.fn(async () => null) }),
    );
    await expect(
      provider.request({ method: 'wallet_getCapabilities', params: [] }),
    ).rejects.toEqual(rpcError(4100));
  });
});

describe('wallet_sendCalls', () => {
  it('submits the batch once and returns its id, as viem expects', async () => {
    const { client, wallet } = setup();
    await expect(sendCalls(wallet(), { calls: CALLS })).resolves.toEqual({
      id: 'batch-1',
    });
    expect(client.sendCalls).toHaveBeenCalledTimes(1);
    const [request] = client.sendCalls.mock.calls[0]!;
    expect(request).toEqual({
      requestId: expect.stringMatching(UUID),
      from: WALLET_ADDRESS,
      chainId: SEPOLIA,
      calls: [
        { to: TO, data: '0x095ea7b3' },
        { to: TO, value: '0x1' },
      ],
    });
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('accepts atomicRequired and optional capabilities', async () => {
    const { client, wallet } = setup();
    await sendCalls(wallet(), {
      calls: CALLS,
      forceAtomic: true,
      capabilities: { dataSuffix: { value: '0x1234', optional: true } },
    });
    expect(client.sendCalls).toHaveBeenCalledTimes(1);
  });

  it('uses a new requestId for each batch', async () => {
    const { client, wallet } = setup();
    await sendCalls(wallet(), { calls: CALLS });
    await sendCalls(wallet(), { calls: CALLS });
    const [[a], [b]] = client.sendCalls.mock.calls as [
      [{ requestId: string }],
      [{ requestId: string }],
    ];
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('refuses a chain the server does not batch on with 5710, without sending', async () => {
    const { client, wallet } = setup(batchingClient(), {
      initialChainId: mainnet.id,
    });
    await expectRpcCode(sendCalls(wallet(mainnet), { calls: CALLS }), 5710);
    // viem's fallback must not turn the refusal into separate sends.
    await expectRpcCode(
      sendCalls(wallet(mainnet), { calls: CALLS, experimental_fallback: true }),
      5710,
    );
    expect(client.sendCalls).not.toHaveBeenCalled();
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses with 5760 when atomicity is required on a chain that cannot batch', async () => {
    const { client, wallet } = setup(batchingClient(), {
      initialChainId: mainnet.id,
    });
    await expectRpcCode(
      sendCalls(wallet(mainnet), { calls: CALLS, forceAtomic: true }),
      5760,
    );
    expect(client.sendCalls).not.toHaveBeenCalled();
  });

  it('refuses every chain when the server reports no batch chains', async () => {
    const { client, wallet } = setup(createFakeClient());
    await expectRpcCode(sendCalls(wallet(), { calls: CALLS }), 5710);
    expect(client.sendCalls).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured chain with 5710', async () => {
    const { client, provider } = setup();
    await expect(
      provider.request({
        method: 'wallet_sendCalls',
        params: [{ version: '2.0.0', chainId: '0x5', calls: [{ to: TO }] }],
      }),
    ).rejects.toEqual(rpcError(5710));
    expect(client.sendCalls).not.toHaveBeenCalled();
  });

  it('maps BATCH_NOT_SUPPORTED from the server to 5710', async () => {
    const client = batchingClient({
      sendCalls: vi.fn(async () => {
        throw clientError(ERROR_CODE.BATCH_NOT_SUPPORTED, 400);
      }),
    });
    const { wallet } = setup(client);
    await expectRpcCode(sendCalls(wallet(), { calls: CALLS }), 5710);
    expect(client.sendCalls).toHaveBeenCalledTimes(1);
  });

  it('maps a server refusal to its RPC code and resets on ACCOUNT_MISMATCH', async () => {
    const denied = batchingClient({
      sendCalls: vi.fn(async () => {
        throw clientError(ERROR_CODE.POLICY_DENIED, 403);
      }),
    });
    await expectRpcCode(
      sendCalls(setup(denied).wallet(), { calls: CALLS }),
      -32003,
    );

    const mismatch = batchingClient({
      sendCalls: vi.fn(async () => {
        throw clientError(ERROR_CODE.ACCOUNT_MISMATCH, 409);
      }),
    });
    const { provider, wallet } = setup(mismatch);
    const listener = vi.fn();
    provider.on('accountsChanged', listener);
    await expectRpcCode(sendCalls(wallet(), { calls: CALLS }), 4100);
    expect(listener).toHaveBeenCalledWith([]);
  });

  const raw = (batch: Record<string, unknown>) => ({
    method: 'wallet_sendCalls',
    params: [
      { version: '2.0.0', chainId: '0xaa36a7', calls: [{ to: TO }], ...batch },
    ],
  });

  it.each([
    ['no params', undefined, -32602],
    ['an empty batch', { calls: [] }, -32602],
    ['calls that are not an array', { calls: { to: TO } }, -32602],
    [
      'more than MAX_BATCH_CALLS calls',
      {
        calls: Array.from({ length: MAX_BATCH_CALLS + 1 }, () => ({ to: TO })),
      },
      5740,
    ],
    ['a call without to', { calls: [{ data: '0x' }] }, -32602],
    ['a call with non-hex data', { calls: [{ to: TO, data: 'hi' }] }, -32602],
    ['a call with a numeric value', { calls: [{ to: TO, value: 1 }] }, -32602],
    [
      'a call with an unknown field',
      { calls: [{ to: TO, gas: '0x1' }] },
      -32602,
    ],
    [
      'a non-optional call capability',
      { calls: [{ to: TO, capabilities: { paymasterService: { url: 'x' } } }] },
      5700,
    ],
    [
      'a non-optional batch capability',
      { capabilities: { paymasterService: { url: 'x' } } },
      5700,
    ],
    ['a caller-supplied id', { id: 'my-batch' }, -32602],
    ['another version', { version: '1.0' }, -32602],
    ['a non-boolean atomicRequired', { atomicRequired: 'yes' }, -32602],
    ['an unknown field', { gasLimit: '0x1' }, -32602],
    ['a malformed chainId', { chainId: 'sepolia' }, -32602],
    [
      'another from address',
      { from: '0x0000000000000000000000000000000000000001' },
      4100,
    ],
  ])('refuses %s with %s and sends nothing', async (_, batch, code) => {
    const { client, provider } = setup();
    const request =
      batch === undefined
        ? { method: 'wallet_sendCalls', params: [] }
        : raw(batch as Record<string, unknown>);
    await expect(provider.request(request)).rejects.toEqual(rpcError(code));
    expect(client.sendCalls).not.toHaveBeenCalled();
  });

  it('sends on the requested chain when it is a batch chain', async () => {
    const { client, provider } = setup(batchingClient(), {
      initialChainId: mainnet.id,
    });
    await provider.request(raw({ from: WALLET_ADDRESS.toLowerCase() }));
    expect(client.sendCalls.mock.calls[0]![0]).toMatchObject({
      chainId: SEPOLIA,
    });
  });
});

describe('wallet_sendCalls retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries an ambiguous failure with the same requestId', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(clientError(ERROR_CODE.PROVIDER_ERROR, 0))
      .mockRejectedValueOnce(clientError(ERROR_CODE.PROVIDER_ERROR, 502))
      .mockResolvedValueOnce({ id: 'batch-9', status: 'pending' });
    const { provider } = setup(batchingClient({ sendCalls: send }));
    const settled = provider
      .request({
        method: 'wallet_sendCalls',
        params: [
          { version: '2.0.0', chainId: '0xaa36a7', calls: [{ to: TO }] },
        ],
      })
      .then((value) => ({ value }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toEqual({ value: { id: 'batch-9' } });
    const ids = send.mock.calls.map(
      ([request]) => (request as { requestId: string }).requestId,
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('does not retry a definite refusal, and reports the requestId', async () => {
    const send = vi.fn(async () => {
      throw clientError(ERROR_CODE.POLICY_DENIED, 403);
    });
    const { provider } = setup(batchingClient({ sendCalls: send }));
    const settled = provider
      .request({
        method: 'wallet_sendCalls',
        params: [
          { version: '2.0.0', chainId: '0xaa36a7', calls: [{ to: TO }] },
        ],
      })
      .catch((error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    const { error } = (await settled) as {
      error: { code: number; data: { requestId: string } };
    };
    expect(error.code).toBe(-32003);
    expect(error.data.requestId).toMatch(UUID);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('wallet_getCallsStatus', () => {
  const withTransaction = (
    tx: TransactionResponse,
    extra: Partial<Parameters<typeof createEmbeddedProvider>[0]> = {},
  ) => setup(batchingClient({ getTransaction: vi.fn(async () => tx) }), extra);

  it('reports a pending batch as 100 with no receipts', async () => {
    const { provider, wallet } = withTransaction({
      id: 'b1',
      status: 'pending',
      chainId: SEPOLIA,
    });
    await expect(
      provider.request({ method: 'wallet_getCallsStatus', params: ['b1'] }),
    ).resolves.toEqual({
      version: '2.0.0',
      id: 'b1',
      chainId: '0xaa36a7',
      status: 100,
      atomic: true,
    });
    await expect(getCallsStatus(wallet(), { id: 'b1' })).resolves.toEqual({
      version: '2.0.0',
      id: 'b1',
      chainId: SEPOLIA,
      status: 'pending',
      statusCode: 100,
      atomic: true,
      receipts: [],
    });
  });

  it('reports a confirmed batch as 200 with its receipt when a reader is given', async () => {
    const getTransactionReceipt = vi.fn(async () => RECEIPT);
    const { provider, wallet } = withTransaction(
      { id: 'b1', status: 'confirmed', hash: HASH, chainId: SEPOLIA },
      { getTransactionReceipt },
    );
    await expect(
      provider.request({ method: 'wallet_getCallsStatus', params: ['b1'] }),
    ).resolves.toEqual({
      version: '2.0.0',
      id: 'b1',
      chainId: '0xaa36a7',
      status: 200,
      atomic: true,
      receipts: [
        {
          logs: [{ address: TO, data: '0x', topics: [`0x${'ef'.repeat(32)}`] }],
          status: '0x1',
          blockHash: RECEIPT.blockHash,
          blockNumber: '0x10',
          gasUsed: '0x5208',
          transactionHash: HASH,
        },
      ],
    });
    expect(getTransactionReceipt).toHaveBeenCalledWith({
      chainId: SEPOLIA,
      hash: HASH,
    });
    const viewed = await getCallsStatus(wallet(), { id: 'b1' });
    expect(viewed).toMatchObject({ status: 'success', statusCode: 200 });
    expect(viewed.receipts![0]).toMatchObject({
      transactionHash: HASH,
      blockNumber: 16n,
      gasUsed: 21000n,
      status: 'success',
    });
  });

  it('reports confirmed without receipts when no reader is given', async () => {
    const { provider } = withTransaction({
      id: 'b1',
      status: 'confirmed',
      hash: HASH,
      chainId: SEPOLIA,
    });
    const status = await provider.request({
      method: 'wallet_getCallsStatus',
      params: ['b1'],
    });
    expect(status).toMatchObject({ status: 200 });
    expect(status).not.toHaveProperty('receipts');
  });

  it('stays pending while the app node has no receipt yet', async () => {
    const { provider } = withTransaction(
      { id: 'b1', status: 'confirmed', hash: HASH, chainId: SEPOLIA },
      { getTransactionReceipt: async () => null },
    );
    await expect(
      provider.request({ method: 'wallet_getCallsStatus', params: ['b1'] }),
    ).resolves.toMatchObject({ status: 100 });
  });

  it('reports a failed batch with a hash as 500 and without one as 400', async () => {
    const reverted = withTransaction(
      { id: 'b1', status: 'failed', hash: HASH, chainId: SEPOLIA },
      { getTransactionReceipt: async () => ({ ...RECEIPT, status: '0x0' }) },
    );
    await expect(
      reverted.provider.request({
        method: 'wallet_getCallsStatus',
        params: ['b1'],
      }),
    ).resolves.toMatchObject({
      status: 500,
      receipts: [expect.objectContaining({ status: '0x0' })],
    });
    await expect(
      getCallsStatus(reverted.wallet(), { id: 'b1' }),
    ).resolves.toMatchObject({ status: 'failure', statusCode: 500 });

    const dropped = withTransaction({
      id: 'b2',
      status: 'failed',
      chainId: SEPOLIA,
    });
    await expect(
      dropped.provider.request({
        method: 'wallet_getCallsStatus',
        params: ['b2'],
      }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it('falls back to the current chain when the server does not report one', async () => {
    const { provider } = withTransaction(
      { id: 'b1', status: 'pending' },
      { initialChainId: mainnet.id },
    );
    await expect(
      provider.request({ method: 'wallet_getCallsStatus', params: ['b1'] }),
    ).resolves.toMatchObject({ chainId: '0x1' });
  });

  it('maps an unknown id to 5730', async () => {
    for (const code of [
      ERROR_CODE.TRANSACTION_NOT_FOUND,
      ERROR_CODE.INVALID_REQUEST,
    ]) {
      const { provider } = setup(
        batchingClient({
          getTransaction: vi.fn(async () => {
            throw clientError(code, 404);
          }),
        }),
      );
      await expect(
        provider.request({ method: 'wallet_getCallsStatus', params: ['nope'] }),
      ).rejects.toEqual(rpcError(5730));
    }
  });

  it('rejects a missing id with -32602', async () => {
    const { provider } = setup();
    await expect(
      provider.request({ method: 'wallet_getCallsStatus', params: [] }),
    ).rejects.toEqual(rpcError(-32602));
  });

  it('lets viem waitForCallsStatus follow a batch to success', async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ id: 'b1', status: 'pending', chainId: SEPOLIA })
      .mockResolvedValueOnce({
        id: 'b1',
        status: 'pending',
        hash: HASH,
        chainId: SEPOLIA,
      })
      .mockResolvedValue({
        id: 'b1',
        status: 'confirmed',
        hash: HASH,
        chainId: SEPOLIA,
      });
    const { wallet } = setup(batchingClient({ getTransaction }), {
      getTransactionReceipt: async () => RECEIPT,
    });
    const { id } = await sendCalls(wallet(), { calls: CALLS });
    const result = await waitForCallsStatus(wallet(), {
      id,
      timeout: 5_000,
    });
    expect(result).toMatchObject({ status: 'success', statusCode: 200 });
    expect(result.receipts![0]!.transactionHash).toBe(HASH);
    expect(getTransaction).toHaveBeenCalledWith('batch-1');
  });
});
