import {
  TRANSACTION_STATUS,
  type Address,
  type Hex,
  type SignableMessage,
  type TransactionRequest,
} from '../protocol/index';
import { ERROR_CODE, type ErrorCode } from '../protocol/index';
import type { EmbeddedWalletClient } from './client';
import { EmbeddedWalletClientError } from './errors';
import {
  EmbeddedProviderError,
  RPC_ERROR_CODE,
  toProviderError,
  withErrorData,
} from './provider-errors';
import { parseTransactionParams } from './transaction-params';

export const DEFAULT_POLLING_INTERVAL_MS = 1_000;
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 120_000;
/** Polling backs off by this factor per attempt, up to the cap below. */
const POLL_BACKOFF_FACTOR = 1.5;
const MAX_POLLING_INTERVAL_MS = 5_000;
/** An ambiguous send failure is retried this many times, with the same requestId. */
const SEND_RETRIES = 2;
/** Wait before retry n is this times n. */
const SEND_RETRY_DELAY_MS = 300;

/** Failures that mean the cached address can no longer be trusted. */
const ACCOUNT_LOST_CODES: readonly ErrorCode[] = [
  ERROR_CODE.ACCOUNT_MISMATCH,
  ERROR_CODE.UNAUTHENTICATED,
  ERROR_CODE.REAUTH_REQUIRED,
];

/** True when the request may or may not have reached Privy, so a repeat is safe only with the same requestId. */
const isAmbiguousSendFailure = (error: unknown) =>
  error instanceof EmbeddedWalletClientError &&
  (error.status === 0 ||
    error.status >= 500 ||
    error.code === ERROR_CODE.PROVIDER_ERROR);

export interface EmbeddedProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
  /** Current chain id. */
  readonly chainId: number;
  /** Sets the chain without calling `onChainChanged` or emitting events. Ignores unknown chains. */
  setChainId(chainId: number): void;
  /** Drops the cached wallet address. Call when the session or connection ends. */
  reset(): void;
}

export interface CreateEmbeddedProviderOptions {
  client: EmbeddedWalletClient;
  /** Chains the provider may switch to. */
  chainIds: readonly [number, ...number[]];
  /** Starting chain. Must be one of `chainIds`. Defaults to the first. */
  initialChainId?: number;
  /** First delay between transaction polls, in ms. Backs off up to 5 seconds. */
  pollingInterval?: number;
  /** How long `eth_sendTransaction` waits for a hash, in ms. */
  transactionTimeout?: number;
  /**
   * Called after the chain changes and before `chainChanged` listeners run.
   * The connector uses it to persist the chain and emit its own event.
   */
  onChainChanged?: (chainId: number) => void | Promise<void>;
}

type Params = readonly unknown[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isHexString = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

const invalidParams = (message: string) =>
  new EmbeddedProviderError(RPC_ERROR_CODE.INVALID_PARAMS, message);

function toChainNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    return Number.parseInt(value, 16);
  }
  return null;
}

const toHexQuantity = (n: number) => `0x${n.toString(16)}`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createEmbeddedProvider(
  options: CreateEmbeddedProviderOptions,
): EmbeddedProvider {
  const { chainIds } = options;
  const pollingInterval =
    options.pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS;
  const transactionTimeout =
    options.transactionTimeout ?? DEFAULT_TRANSACTION_TIMEOUT_MS;

  let chainId =
    options.initialChainId !== undefined &&
    chainIds.includes(options.initialChainId)
      ? options.initialChainId
      : chainIds[0];
  let cachedAddress: Address | null = null;
  const listeners = new Map<string, Set<(...args: never[]) => void>>();

  function emit(event: string, ...args: unknown[]) {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  /** Drops the cached address and tells listeners the account is gone. */
  function accountLost() {
    cachedAddress = null;
    emit('accountsChanged', []);
  }

  /** Wraps a client call so account-binding failures reset this provider. */
  function guarded<A extends unknown[], R>(
    call: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      try {
        return await call(...args);
      } catch (error) {
        if (
          error instanceof EmbeddedWalletClientError &&
          ACCOUNT_LOST_CODES.includes(error.code)
        ) {
          accountLost();
        }
        throw error;
      }
    };
  }

  // Export is deliberately not reachable through the provider.
  const client: Omit<EmbeddedWalletClient, 'exportWallet'> = {
    getWallet: guarded(() => options.client.getWallet()),
    ensureWallet: guarded(() => options.client.ensureWallet()),
    signMessage: guarded((request) => options.client.signMessage(request)),
    sendTransaction: guarded((request) =>
      options.client.sendTransaction(request),
    ),
    getTransaction: guarded((id) => options.client.getTransaction(id)),
  };

  async function requireWalletAddress(): Promise<Address> {
    if (cachedAddress) return cachedAddress;
    const wallet = await client.getWallet();
    if (!wallet) {
      throw new EmbeddedProviderError(
        RPC_ERROR_CODE.UNAUTHORIZED,
        'No wallet is available for this account.',
      );
    }
    cachedAddress = wallet.address;
    return cachedAddress;
  }

  async function accounts(create: boolean): Promise<Address[]> {
    if (create) {
      cachedAddress = (await client.ensureWallet()).address;
      return [cachedAddress];
    }
    try {
      return [await requireWalletAddress()];
    } catch (error) {
      // Not signed in or no wallet: EIP-1193 says an empty list, not an error.
      const err = toProviderError(error);
      if (err.code === RPC_ERROR_CODE.UNAUTHORIZED) return [];
      throw err;
    }
  }

  async function personalSign(params: Params): Promise<Hex> {
    const [data, address] = params;
    if (typeof data !== 'string' || typeof address !== 'string') {
      throw invalidParams('personal_sign expects [data, address].');
    }
    const wallet = await requireWalletAddress();
    if (!sameAddress(wallet, address)) {
      throw new EmbeddedProviderError(
        RPC_ERROR_CODE.UNAUTHORIZED,
        'The requested address is not the connected wallet.',
      );
    }
    const message: SignableMessage = isHexString(data) ? { raw: data } : data;
    return (await client.signMessage({ address: wallet, message })).signature;
  }

  async function waitForHash(id: string, requestId: string): Promise<Hex> {
    const deadline = Date.now() + transactionTimeout;
    let delay = pollingInterval;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EmbeddedProviderError(
          RPC_ERROR_CODE.INTERNAL,
          'Timed out waiting for the transaction hash. The transaction may still complete.',
          { data: { requestId, id } },
        );
      }
      await sleep(Math.min(delay, remaining));
      const tx = await client.getTransaction(id);
      // Capture the hash first so a failed transaction can still report it.
      const { hash } = tx;
      if (tx.status === TRANSACTION_STATUS.FAILED) {
        throw failedTransaction(requestId, id, hash);
      }
      if (hash) return hash;
      delay = Math.min(delay * POLL_BACKOFF_FACTOR, MAX_POLLING_INTERVAL_MS);
    }
  }

  const failedTransaction = (requestId: string, id: string, hash?: Hex) =>
    new EmbeddedProviderError(
      RPC_ERROR_CODE.TRANSACTION_FAILED,
      'The transaction failed.',
      { data: { requestId, id, ...(hash ? { hash } : {}) } },
    );

  /** Submits once per intent. Ambiguous failures retry with the same requestId. */
  async function submit(request: TransactionRequest) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.sendTransaction(request);
      } catch (error) {
        if (attempt < SEND_RETRIES && isAmbiguousSendFailure(error)) {
          await sleep(SEND_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw withErrorData(error, { requestId: request.requestId });
      }
    }
  }

  async function sendTransaction(params: Params): Promise<Hex> {
    const raw = params[0];
    if (!isRecord(raw))
      throw invalidParams('eth_sendTransaction expects [tx].');
    const wallet = await requireWalletAddress();
    if (typeof raw.from === 'string' && !sameAddress(raw.from, wallet)) {
      throw new EmbeddedProviderError(
        RPC_ERROR_CODE.UNAUTHORIZED,
        'The "from" address is not the connected wallet.',
      );
    }
    const tx = parseTransactionParams(raw, chainId);
    const request: TransactionRequest = {
      requestId: crypto.randomUUID(),
      from: wallet,
      chainId,
      to: tx.to,
    };
    if (tx.data !== undefined) request.data = tx.data;
    if (tx.value !== undefined) request.value = tx.value;

    const submitted = await submit(request);
    const { hash } = submitted;
    if (submitted.status === TRANSACTION_STATUS.FAILED) {
      throw failedTransaction(request.requestId, submitted.id, hash);
    }
    return hash ?? waitForHash(submitted.id, request.requestId);
  }

  async function switchChain(params: Params): Promise<null> {
    const first = params[0];
    const target = isRecord(first) ? toChainNumber(first.chainId) : null;
    if (target === null) {
      throw invalidParams('wallet_switchEthereumChain expects [{ chainId }].');
    }
    if (!chainIds.includes(target)) {
      throw new EmbeddedProviderError(
        RPC_ERROR_CODE.UNRECOGNIZED_CHAIN,
        `Chain ${toHexQuantity(target)} is not configured for this wallet.`,
      );
    }
    if (target !== chainId) {
      chainId = target;
      await options.onChainChanged?.(target);
      emit('chainChanged', toHexQuantity(target));
    }
    return null;
  }

  async function dispatch(method: string, params: Params): Promise<unknown> {
    switch (method) {
      case 'eth_accounts':
        return accounts(false);
      case 'eth_requestAccounts':
        return accounts(true);
      case 'eth_chainId':
        return toHexQuantity(chainId);
      case 'personal_sign':
        return personalSign(params);
      case 'eth_sendTransaction':
        return sendTransaction(params);
      case 'wallet_switchEthereumChain':
        return switchChain(params);
      default:
        throw new EmbeddedProviderError(
          RPC_ERROR_CODE.UNSUPPORTED_METHOD,
          `The method ${method} is not supported by this wallet.`,
        );
    }
  }

  return {
    get chainId() {
      return chainId;
    },
    async request({ method, params }) {
      try {
        const list = Array.isArray(params) ? params : [];
        return await dispatch(method, list);
      } catch (error) {
        throw toProviderError(error);
      }
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    setChainId(next) {
      if (chainIds.includes(next)) chainId = next;
    },
    reset() {
      cachedAddress = null;
    },
  };
}
