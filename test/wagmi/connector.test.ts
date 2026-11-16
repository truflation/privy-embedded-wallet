import {
  connect,
  createConfig,
  createStorage,
  custom,
  disconnect,
  getAccount,
  getCallsStatus,
  getCapabilities,
  http,
  reconnect,
  sendCalls,
  switchChain,
} from '@wagmi/core';
import { mainnet, sepolia } from '@wagmi/core/chains';
import { describe, expect, it, vi } from 'vitest';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  EmbeddedWalletClientError,
  ERROR_CODE,
  LoginRequiredError,
} from '../../src/client/index';
import {
  embeddedWallet,
  getEmbeddedWalletConnector,
  LoginRequiredError as WagmiLoginRequiredError,
  type EmbeddedWalletConnectorProperties,
  type EmbeddedWalletOptions,
} from '../../src/wagmi/index';
import {
  WALLET_ADDRESS,
  createFakeClient,
  memoryStorage,
} from '../client/helpers';

describe('wagmi entry', () => {
  it('re-exports the same LoginRequiredError class as the client entry', () => {
    expect(WagmiLoginRequiredError).toBe(LoginRequiredError);
  });
});

function build(
  overrides: Partial<EmbeddedWalletOptions> = {},
  storage = memoryStorage(),
) {
  const client = overrides.client ?? createFakeClient();
  const hasSession = vi.fn(overrides.hasSession ?? (() => true));
  const onLoginRequired = vi.fn();
  const config = createConfig({
    chains: [mainnet, sepolia],
    transports: { [mainnet.id]: http(), [sepolia.id]: http() },
    storage: createStorage({ storage }),
    connectors: [
      embeddedWallet({
        onLoginRequired,
        ...overrides,
        client,
        hasSession,
      }),
    ],
  });
  const connector = config.connectors[0]! as (typeof config.connectors)[0] &
    EmbeddedWalletConnectorProperties;
  return { config, connector, client, hasSession, onLoginRequired, storage };
}

describe('connect', () => {
  it('ensures the wallet and returns accounts and the first chain', async () => {
    const { connector, client } = build();
    const result = await connector.connect();
    expect(result).toEqual({ accounts: [WALLET_ADDRESS], chainId: 1 });
    expect(client.ensureWallet).toHaveBeenCalledTimes(1);
  });

  it('honours a configured chainId and ignores an unconfigured one', async () => {
    const { connector } = build();
    expect(await connector.connect({ chainId: sepolia.id })).toMatchObject({
      chainId: sepolia.id,
    });
    expect(await connector.connect({ chainId: 999 })).toMatchObject({
      chainId: sepolia.id,
    });
  });

  it('returns capability objects when asked', async () => {
    const { connector } = build();
    expect(await connector.connect({ withCapabilities: true })).toMatchObject({
      accounts: [{ address: WALLET_ADDRESS, capabilities: {} }],
    });
  });

  it('without a session calls onLoginRequired and throws LoginRequiredError', async () => {
    const { connector, client, onLoginRequired } = build({
      hasSession: () => false,
    });
    await expect(connector.connect()).rejects.toBeInstanceOf(
      LoginRequiredError,
    );
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
    expect(client.ensureWallet).not.toHaveBeenCalled();
  });

  it('supports an async hasSession', async () => {
    const { connector } = build({ hasSession: async () => true });
    await expect(connector.connect()).resolves.toMatchObject({ chainId: 1 });
  });

  it('does not call onLoginRequired while reconnecting', async () => {
    const { connector, onLoginRequired } = build({ hasSession: () => false });
    await expect(
      connector.connect({ isReconnecting: true }),
    ).rejects.toBeInstanceOf(LoginRequiredError);
    expect(onLoginRequired).not.toHaveBeenCalled();
  });

  it('propagates ensureWallet failures', async () => {
    const client = createFakeClient({
      ensureWallet: vi.fn(async () => {
        throw new EmbeddedWalletClientError(
          ERROR_CODE.REAUTH_REQUIRED,
          'x',
          401,
        );
      }),
    });
    const { connector } = build({ client });
    await expect(connector.connect()).rejects.toMatchObject({
      code: ERROR_CODE.REAUTH_REQUIRED,
    });
  });
});

describe('isAuthorized', () => {
  it('is true with a session and a wallet', async () => {
    expect(await build().connector.isAuthorized()).toBe(true);
  });

  it('is false without a session, without checking the wallet', async () => {
    const { connector, client } = build({ hasSession: () => false });
    expect(await connector.isAuthorized()).toBe(false);
    expect(client.getWallet).not.toHaveBeenCalled();
  });

  it('is false when the wallet does not exist', async () => {
    const client = createFakeClient({ getWallet: vi.fn(async () => null) });
    expect(await build({ client }).connector.isAuthorized()).toBe(false);
  });

  it('is false, not thrown, when anything fails', async () => {
    const client = createFakeClient({
      getWallet: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await build({ client }).connector.isAuthorized()).toBe(false);
    const sessionThrows = build({
      hasSession: () => {
        throw new Error('boom');
      },
    });
    expect(await sessionThrows.connector.isAuthorized()).toBe(false);
  });
});

describe('chain persistence and switching', () => {
  it('switchChain updates state, persists under a namespaced key, and emits change', async () => {
    const { connector, config, storage } = build({ id: 'my-wallet' });
    await connector.connect();
    const onChange = vi.fn();
    connector.emitter.on('change', onChange);
    const chain = await connector.switchChain!({ chainId: sepolia.id });
    expect(chain.id).toBe(sepolia.id);
    expect(await connector.getChainId()).toBe(sepolia.id);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: sepolia.id }),
    );
    expect(storage.getItem(`${config.storage!.key}.my-wallet.chainId`)).toBe(
      String(sepolia.id),
    );
  });

  it('rejects switching to an unconfigured chain', async () => {
    const { connector } = build();
    await expect(
      connector.switchChain!({ chainId: 999 }),
    ).rejects.toMatchObject({
      code: 4902,
    });
  });

  it('restores the chain after a simulated reload', async () => {
    const storage = memoryStorage();
    const first = build({}, storage);
    await connect(first.config, { connector: first.connector });
    await switchChain(first.config, { chainId: sepolia.id });
    expect(getAccount(first.config).chainId).toBe(sepolia.id);

    const second = build({}, storage);
    await reconnect(second.config);
    const account = getAccount(second.config);
    expect(account.status).toBe('connected');
    expect(account.chainId).toBe(sepolia.id);
    expect(await second.connector.getChainId()).toBe(sepolia.id);
  });

  it('does not reconnect after reload when the session is gone', async () => {
    const storage = memoryStorage();
    const first = build({}, storage);
    await connect(first.config, { connector: first.connector });
    const second = build({ hasSession: () => false }, storage);
    await reconnect(second.config);
    expect(getAccount(second.config).status).toBe('disconnected');
  });
});

describe('disconnect and session end', () => {
  it('disconnect clears connector state and touches nothing on the host', async () => {
    const { config, connector, client, hasSession } = build();
    await connect(config, { connector });
    const callsBefore = Object.values(client).reduce(
      (sum, fn) => sum + (fn as ReturnType<typeof vi.fn>).mock.calls.length,
      0,
    );
    await disconnect(config);
    expect(getAccount(config).status).toBe('disconnected');
    const callsAfter = Object.values(client).reduce(
      (sum, fn) => sum + (fn as ReturnType<typeof vi.fn>).mock.calls.length,
      0,
    );
    expect(callsAfter).toBe(callsBefore);
    // The session is still live: the user can connect again.
    expect(hasSession()).toBe(true);
    await expect(connect(config, { connector })).resolves.toBeDefined();
  });

  it('notifySessionEnded emits disconnect so wagmi drops the connection', async () => {
    const { config, connector } = build();
    await connect(config, { connector });
    expect(getAccount(config).status).toBe('connected');
    connector.notifySessionEnded();
    expect(getAccount(config).status).toBe('disconnected');
  });

  it('getAccounts is empty once the session is gone', async () => {
    let session = true;
    const { connector } = build({ hasSession: () => session });
    expect(await connector.getAccounts()).toEqual([WALLET_ADDRESS]);
    session = false;
    expect(await connector.getAccounts()).toEqual([]);
  });

  it('wagmi-facing callbacks emit change and disconnect', () => {
    const { connector } = build();
    const change = vi.fn();
    const gone = vi.fn();
    connector.emitter.on('change', change);
    connector.emitter.on('disconnect', gone);
    connector.onChainChanged('0xaa36a7');
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: sepolia.id }),
    );
    connector.onAccountsChanged([WALLET_ADDRESS.toLowerCase()]);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ accounts: [WALLET_ADDRESS] }),
    );
    connector.onAccountsChanged([]);
    connector.onDisconnect();
    expect(gone).toHaveBeenCalledTimes(2);
  });
});

describe('getProvider', () => {
  it('returns a working provider before connect', async () => {
    const { connector } = build();
    const provider = await connector.getProvider();
    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe(
      '0x1',
    );
  });

  it('exposes the configured identity', () => {
    const { connector } = build({
      id: 'acct',
      name: 'Acct',
      icon: 'data:image/png;base64,AA',
    });
    expect(connector).toMatchObject({
      id: 'acct',
      name: 'Acct',
      icon: 'data:image/png;base64,AA',
    });
  });
});

describe('wagmi round trip', () => {
  it('connects, signs a message the server key can verify, and reports the account', async () => {
    const account = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    );
    const client = createFakeClient({
      getWallet: vi.fn(async () => ({ address: account.address })),
      ensureWallet: vi.fn(async () => ({ address: account.address })),
      signMessage: vi.fn(async ({ message }) => ({
        signature: await account.signMessage({ message }),
      })),
    });
    const { config, connector } = build({ client });
    await connect(config, { connector });
    const state = getAccount(config);
    expect(state).toMatchObject({
      status: 'connected',
      address: account.address,
      chainId: 1,
    });

    const { signMessage } = await import('@wagmi/core');
    const message = 'hello wagmi';
    const signature = await signMessage(config, { message });
    expect(
      await verifyMessage({ address: account.address, message, signature }),
    ).toBe(true);
    expect(client.signMessage).toHaveBeenCalledWith({
      address: account.address,
      message: { raw: expect.stringMatching(/^0x/) },
    });
  });
});

describe('lost account handling', () => {
  const lostCodes = [
    [ERROR_CODE.ACCOUNT_MISMATCH, 409],
    [ERROR_CODE.UNAUTHENTICATED, 401],
    [ERROR_CODE.REAUTH_REQUIRED, 401],
  ] as const;

  it.each(lostCodes)(
    'wagmi becomes disconnected after a sign fails with %s',
    async (code, status) => {
      const client = createFakeClient({
        signMessage: vi.fn(async () => {
          throw new EmbeddedWalletClientError(code, 'x', status);
        }),
      });
      const { config, connector } = build({ client });
      await connect(config, { connector });
      expect(getAccount(config).status).toBe('connected');

      const { signMessage } = await import('@wagmi/core');
      await expect(
        signMessage(config, { message: 'hi' }),
      ).rejects.toBeDefined();
      expect(getAccount(config).status).toBe('disconnected');
    },
  );

  it.each(lostCodes)(
    'wagmi becomes disconnected after a send fails with %s',
    async (code, status) => {
      const client = createFakeClient({
        sendTransaction: vi.fn(async () => {
          throw new EmbeddedWalletClientError(code, 'x', status);
        }),
      });
      const { config, connector } = build({ client });
      await connect(config, { connector });
      const { sendTransaction } = await import('@wagmi/core');
      await expect(
        sendTransaction(config, { to: WALLET_ADDRESS, value: 0n }),
      ).rejects.toBeDefined();
      expect(getAccount(config).status).toBe('disconnected');
    },
  );

  it('stays connected after an unrelated failure', async () => {
    const client = createFakeClient({
      signMessage: vi.fn(async () => {
        throw new EmbeddedWalletClientError(ERROR_CODE.POLICY_DENIED, 'x', 403);
      }),
    });
    const { config, connector } = build({ client });
    await connect(config, { connector });
    const { signMessage } = await import('@wagmi/core');
    await expect(signMessage(config, { message: 'hi' })).rejects.toBeDefined();
    expect(getAccount(config).status).toBe('connected');
  });

  it('can reconnect after a lost account', async () => {
    const client = createFakeClient({
      signMessage: vi.fn(async () => {
        throw new EmbeddedWalletClientError(
          ERROR_CODE.ACCOUNT_MISMATCH,
          'x',
          409,
        );
      }),
    });
    const { config, connector } = build({ client });
    await connect(config, { connector });
    const { signMessage } = await import('@wagmi/core');
    await signMessage(config, { message: 'hi' }).catch(() => undefined);
    expect(getAccount(config).status).toBe('disconnected');
    await connect(config, { connector });
    expect(getAccount(config).status).toBe('connected');
  });

  it('registers the provider listener once across reconnects and removes it on disconnect', async () => {
    const client = createFakeClient({
      signMessage: vi.fn(async () => {
        throw new EmbeddedWalletClientError(
          ERROR_CODE.ACCOUNT_MISMATCH,
          'x',
          409,
        );
      }),
    });
    const { connector } = build({ client });
    const gone = vi.fn();
    connector.emitter.on('disconnect', gone);
    const provider = await connector.getProvider();
    const sign = () =>
      provider
        .request({
          method: 'personal_sign',
          params: ['hi', WALLET_ADDRESS],
        })
        .catch(() => undefined);

    await connector.connect();
    await connector.connect();
    await sign();
    expect(gone).toHaveBeenCalledTimes(1);

    await connector.disconnect();
    await connector.connect();
    await connector.disconnect();
    await sign();
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe('getEmbeddedWalletConnector', () => {
  it('finds the connector by default id and by custom id', () => {
    const byDefault = build();
    expect(getEmbeddedWalletConnector(byDefault.config)).toBe(
      byDefault.connector,
    );
    const custom = build({ id: 'acct' });
    expect(getEmbeddedWalletConnector(custom.config, 'acct')).toBe(
      custom.connector,
    );
    expect(
      typeof getEmbeddedWalletConnector(custom.config, 'acct')!
        .notifySessionEnded,
    ).toBe('function');
  });

  it('returns undefined when no embedded connector has that id', () => {
    const { config } = build({ id: 'acct' });
    expect(getEmbeddedWalletConnector(config)).toBeUndefined();
    expect(getEmbeddedWalletConnector(config, 'other')).toBeUndefined();
  });

  it('returns undefined for a different connector type with the same id', () => {
    expect(
      getEmbeddedWalletConnector({
        connectors: [{ id: 'embedded-wallet', type: 'injected' }] as never,
      }),
    ).toBeUndefined();
  });
});

describe('EIP-5792 through wagmi', () => {
  const HASH = `0x${'ab'.repeat(32)}` as const;
  const RECEIPT = {
    blockHash: `0x${'cd'.repeat(32)}`,
    blockNumber: '0x10',
    gasUsed: '0x5208',
    logs: [],
    status: '0x1',
    transactionHash: HASH,
  };

  function buildBatching() {
    const client = createFakeClient({
      getWallet: vi.fn(async () => ({
        address: WALLET_ADDRESS,
        batchChainIds: [sepolia.id],
      })),
      getTransaction: vi.fn(async () => ({
        id: 'batch-1',
        status: 'confirmed' as const,
        hash: HASH,
        chainId: sepolia.id,
      })),
    });
    const nodeRequest = vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_getTransactionReceipt' ? RECEIPT : null,
    );
    const config = createConfig({
      chains: [mainnet, sepolia],
      transports: {
        [mainnet.id]: http(),
        [sepolia.id]: custom({ request: nodeRequest }),
      },
      storage: createStorage({ storage: memoryStorage() }),
      connectors: [embeddedWallet({ client, hasSession: () => true })],
    });
    return { config, client, nodeRequest, connector: config.connectors[0]! };
  }

  it('reports atomic capabilities, sends a batch and reads its receipt', async () => {
    const { config, client, nodeRequest, connector } = buildBatching();
    await connect(config, { connector, chainId: sepolia.id });

    expect(await getCapabilities(config)).toEqual({
      [mainnet.id]: { atomic: { status: 'unsupported' } },
      [sepolia.id]: { atomic: { status: 'supported' } },
    });

    const { id } = await sendCalls(config, {
      calls: [
        { to: WALLET_ADDRESS, data: '0x' },
        { to: WALLET_ADDRESS, value: 0n },
      ],
    });
    expect(id).toBe('batch-1');
    expect(client.sendCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        from: WALLET_ADDRESS,
        chainId: sepolia.id,
        calls: [{ to: WALLET_ADDRESS, data: '0x' }, { to: WALLET_ADDRESS }],
      }),
    );

    const status = await getCallsStatus(config, { id });
    expect(status).toMatchObject({ status: 'success', statusCode: 200 });
    expect(status.receipts![0]).toMatchObject({
      transactionHash: HASH,
      blockNumber: 16n,
    });
    expect(nodeRequest.mock.calls[0]![0]).toEqual({
      method: 'eth_getTransactionReceipt',
      params: [HASH],
    });
  });

  it('refuses a batch on a chain the server does not batch on', async () => {
    const { config, client, connector } = buildBatching();
    await connect(config, { connector, chainId: mainnet.id });
    const error = await sendCalls(config, {
      calls: [{ to: WALLET_ADDRESS }],
    }).catch((e: unknown) => e);
    expect((error as { name?: string }).name).toBe('TransactionExecutionError');
    expect(((error as Error).cause as { code?: number }).code).toBe(5710);
    expect(client.sendCalls).not.toHaveBeenCalled();
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });
});
