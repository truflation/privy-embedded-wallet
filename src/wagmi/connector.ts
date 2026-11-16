import { createConnector, type Config } from '@wagmi/core';
import { getAddress, type Address } from 'viem';
import type { EmbeddedWalletClient } from '../client/client';
import { LoginRequiredError } from '../client/errors';
import {
  createEmbeddedProvider,
  type EmbeddedProvider,
} from '../client/provider';

export const DEFAULT_CONNECTOR_ID = 'embedded-wallet';
export const DEFAULT_CONNECTOR_NAME = 'Your account';
export const CONNECTOR_TYPE = 'embeddedWallet';

export interface EmbeddedWalletOptions {
  client: EmbeddedWalletClient;
  /** Whether the visitor is signed in to the host site. */
  hasSession: () => boolean | Promise<boolean>;
  /** Called when `connect()` runs for a signed-out visitor, to open the host's login screen. */
  onLoginRequired?: () => void;
  /** Connector id. Also namespaces the persisted chain id. */
  id?: string;
  /** Name shown in wallet pickers such as the AppKit modal. */
  name?: string;
  icon?: string;
  /** First delay between transaction polls, in ms. */
  pollingInterval?: number;
  /** How long a send waits for a transaction hash, in ms. */
  transactionTimeout?: number;
}

export interface EmbeddedWalletConnectorProperties extends Record<
  string,
  unknown
> {
  /**
   * Tell the connector the host session ended (the user signed out of the
   * site, or the session expired). It drops cached wallet state and emits
   * wagmi's `disconnect` event so the app updates. Look the connector up with
   * `getEmbeddedWalletConnector(config, id)` and call this from the host's
   * sign-out handling. `disconnect()` is the opposite direction: it
   * never ends the host session.
   */
  notifySessionEnded(): void;
}

type ConfigConnector = Config['connectors'][number];

/**
 * Finds the embedded wallet connector in a wagmi config, typed with
 * `notifySessionEnded`. Returns `undefined` when there is none with that id.
 */
export function getEmbeddedWalletConnector(
  config: Pick<Config, 'connectors'>,
  id: string = DEFAULT_CONNECTOR_ID,
): (ConfigConnector & EmbeddedWalletConnectorProperties) | undefined {
  const connector = config.connectors.find(
    (c) => c.id === id && c.type === CONNECTOR_TYPE,
  );
  return connector as
    (ConfigConnector & EmbeddedWalletConnectorProperties) | undefined;
}

/** wagmi connector backed by the host's embedded wallet endpoints. */
export function embeddedWallet(options: EmbeddedWalletOptions) {
  const { client, hasSession, onLoginRequired } = options;
  const id = options.id ?? DEFAULT_CONNECTOR_ID;
  const chainStorageKey = `${id}.chainId`;

  return createConnector<EmbeddedProvider, EmbeddedWalletConnectorProperties>(
    (config) => {
      const chainIds = config.chains.map((chain) => chain.id) as [
        number,
        ...number[],
      ];

      const persistChain = async (chainId: number) => {
        await config.storage?.setItem(chainStorageKey, chainId);
      };

      const provider = createEmbeddedProvider({
        client,
        chainIds,
        pollingInterval: options.pollingInterval,
        transactionTimeout: options.transactionTimeout,
        onChainChanged: async (chainId) => {
          await persistChain(chainId);
          config.emitter.emit('change', { chainId });
        },
        // Receipts for `wallet_getCallsStatus`, read through the app's own
        // transport for that chain. No transport means no receipts.
        getTransactionReceipt: async ({ chainId, hash }) => {
          const transport = config.transports?.[chainId];
          const chain = config.chains.find((c) => c.id === chainId);
          if (!transport || !chain) return null;
          return transport({ chain }).request({
            method: 'eth_getTransactionReceipt',
            params: [hash],
          });
        },
      });

      /** The provider reports a lost account here, which wagmi sees as `disconnect`. */
      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length === 0) config.emitter.emit('disconnect');
        else
          config.emitter.emit('change', {
            accounts: accounts.map((a) => getAddress(a)) as Address[],
          });
      };
      const listen = () =>
        provider.on('accountsChanged', handleAccountsChanged as never);
      const unlisten = () =>
        provider.removeListener(
          'accountsChanged',
          handleAccountsChanged as never,
        );

      let restored: Promise<void> | undefined;
      /** Loads the persisted chain once, so a reload keeps the user's choice. */
      const restoreChain = () =>
        (restored ??= (async () => {
          try {
            const saved = await config.storage?.getItem(chainStorageKey);
            if (typeof saved === 'number') provider.setChainId(saved);
          } catch {
            // Unreadable storage falls back to the first configured chain.
          }
        })());

      return {
        id,
        name: options.name ?? DEFAULT_CONNECTOR_NAME,
        icon: options.icon,
        type: CONNECTOR_TYPE,

        async setup() {
          await restoreChain();
        },

        async connect(parameters) {
          if (!(await hasSession())) {
            // Reconnecting on page load must not pop the login screen.
            if (!parameters?.isReconnecting) onLoginRequired?.();
            throw new LoginRequiredError();
          }
          await restoreChain();
          const wallet = await client.ensureWallet();
          const requested = parameters?.chainId;
          if (requested !== undefined && chainIds.includes(requested)) {
            provider.setChainId(requested);
            await persistChain(requested);
          }
          const accounts = [getAddress(wallet.address)];
          unlisten();
          listen();
          return {
            accounts: parameters?.withCapabilities
              ? accounts.map((address) => ({ address, capabilities: {} }))
              : accounts,
            chainId: provider.chainId,
          } as never;
        },

        async disconnect() {
          // Connector state only. The host session is never touched.
          unlisten();
          provider.reset();
        },

        async getAccounts() {
          if (!(await hasSession())) return [];
          const accounts = (await provider.request({
            method: 'eth_accounts',
          })) as string[];
          return accounts.map((address) => getAddress(address));
        },

        async getChainId() {
          await restoreChain();
          return provider.chainId;
        },

        async getProvider() {
          await restoreChain();
          return provider;
        },

        async isAuthorized() {
          try {
            if (!(await hasSession())) return false;
            return (await client.getWallet()) !== null;
          } catch {
            return false;
          }
        },

        async switchChain({ chainId }) {
          await restoreChain();
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${chainId.toString(16)}` }],
          });
          // The provider persisted the chain and emitted `change` already.
          return config.chains.find((chain) => chain.id === chainId)!;
        },

        notifySessionEnded() {
          provider.reset();
          config.emitter.emit('disconnect');
        },

        onAccountsChanged: handleAccountsChanged,
        onChainChanged(chainId) {
          config.emitter.emit('change', { chainId: Number(chainId) });
        },
        onDisconnect() {
          config.emitter.emit('disconnect');
        },
      };
    },
  );
}
