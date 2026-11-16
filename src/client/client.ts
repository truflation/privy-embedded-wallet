import {
  ERROR_CODE,
  ROUTES,
  TRANSACTION_STATUS,
  type Address,
  type ErrorCode,
  type ExportWalletRequest,
  type ExportWalletResponse,
  type Hex,
  type SendCallsRequest,
  type SignMessageRequest,
  type SignMessageResponse,
  type TransactionRequest,
  type TransactionResponse,
  type WalletResponse,
} from '../protocol/index';
import { EmbeddedWalletClientError } from './errors';

/** Header values. Entries whose value is `undefined` are dropped. */
export type HeaderValues =
  Record<string, string | undefined> | Headers | HeadersInit;
type HeadersSource =
  HeaderValues | (() => HeaderValues | Promise<HeaderValues>);

export interface EmbeddedWalletClientOptions {
  /** Where the host mounted the request handler, for example `/api/wallets/embedded`. */
  basePath: string;
  /** Custom fetch, for tests or non-browser runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Extra headers, or a callback returning them (for example a bearer token). */
  headers?: HeadersSource;
}

export interface EmbeddedWalletClient {
  /** The wallet, or `null` when the user has none yet. */
  getWallet(): Promise<WalletResponse | null>;
  /** Finds or creates the wallet. Idempotent. */
  ensureWallet(): Promise<WalletResponse>;
  signMessage(request: SignMessageRequest): Promise<SignMessageResponse>;
  sendTransaction(request: TransactionRequest): Promise<TransactionResponse>;
  /**
   * Sends a batch as one atomic transaction. Only on chains the wallet
   * response lists in `batchChainIds`; elsewhere `BATCH_NOT_SUPPORTED`.
   */
  sendCalls(request: SendCallsRequest): Promise<TransactionResponse>;
  getTransaction(id: string): Promise<TransactionResponse>;
  /**
   * Raw export call: returns ciphertext only. Use `exportPrivateKey`, which
   * generates the recipient key and decrypts in the page.
   */
  exportWallet(request: ExportWalletRequest): Promise<ExportWalletResponse>;
}

const ERROR_CODES: readonly string[] = Object.values(ERROR_CODE);
const TRANSACTION_STATUSES: readonly string[] =
  Object.values(TRANSACTION_STATUS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isHexString = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

const isChainId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function parseWallet(body: unknown): WalletResponse | null {
  if (!isRecord(body) || !isHexString(body.address)) return null;
  const wallet: WalletResponse = { address: body.address as Address };
  if (typeof body.created === 'boolean') wallet.created = body.created;
  // A malformed list is treated as no batching, never as a parse failure,
  // so an unexpected value cannot break the single-send path.
  if (Array.isArray(body.batchChainIds)) {
    wallet.batchChainIds = body.batchChainIds.filter(isChainId);
  }
  return wallet;
}

function parseSignature(body: unknown): SignMessageResponse | null {
  if (!isRecord(body) || !isHexString(body.signature)) return null;
  return { signature: body.signature };
}

function parseTransaction(body: unknown): TransactionResponse | null {
  if (
    !isRecord(body) ||
    typeof body.id !== 'string' ||
    typeof body.status !== 'string' ||
    !TRANSACTION_STATUSES.includes(body.status)
  ) {
    return null;
  }
  if (body.hash !== undefined && !isHexString(body.hash)) return null;
  const tx: TransactionResponse = {
    id: body.id,
    status: body.status as TransactionResponse['status'],
  };
  if (body.hash !== undefined) tx.hash = body.hash;
  if (isChainId(body.chainId)) tx.chainId = body.chainId;
  return tx;
}

function parseExport(body: unknown): ExportWalletResponse | null {
  if (
    !isRecord(body) ||
    typeof body.ciphertext !== 'string' ||
    typeof body.encapsulatedKey !== 'string'
  ) {
    return null;
  }
  return { ciphertext: body.ciphertext, encapsulatedKey: body.encapsulatedKey };
}

function parseErrorBody(
  body: unknown,
): { code: ErrorCode; message: string } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message } = body.error;
  if (typeof code !== 'string' || !ERROR_CODES.includes(code)) return null;
  return {
    code: code as ErrorCode,
    message: typeof message === 'string' ? message : code,
  };
}

function toHeaders(source: HeaderValues | undefined): Headers {
  if (source === undefined) return new Headers();
  if (source instanceof Headers || Array.isArray(source)) {
    return new Headers(source);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(
    source as Record<string, string | undefined>,
  )) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function createEmbeddedWalletClient(
  options: EmbeddedWalletClientOptions,
): EmbeddedWalletClient {
  const base = options.basePath.replace(/\/+$/, '');

  async function resolveHeaders(json: boolean): Promise<Headers> {
    const source =
      typeof options.headers === 'function'
        ? await options.headers()
        : options.headers;
    const headers = toHeaders(source);
    headers.set('Accept', 'application/json');
    if (json) headers.set('Content-Type', 'application/json');
    return headers;
  }

  /** Performs the call and returns the parsed body of a 2xx response. */
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (raw: unknown) => T | null,
    allowNotFound = false,
  ): Promise<T | null> {
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        credentials: 'include',
        headers: await resolveHeaders(method === 'POST'),
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (cause) {
      throw new EmbeddedWalletClientError(
        ERROR_CODE.PROVIDER_ERROR,
        'Could not reach the wallet service.',
        0,
        { cause },
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = undefined;
    }

    if (!response.ok) {
      const parsed = parseErrorBody(raw);
      if (allowNotFound && parsed?.code === ERROR_CODE.WALLET_NOT_FOUND) {
        return null;
      }
      throw new EmbeddedWalletClientError(
        parsed?.code ?? ERROR_CODE.PROVIDER_ERROR,
        parsed?.message ?? `Wallet service responded with ${response.status}.`,
        response.status,
      );
    }

    const value = parse(raw);
    if (value === null) {
      throw new EmbeddedWalletClientError(
        ERROR_CODE.PROVIDER_ERROR,
        'Wallet service returned an unexpected response.',
        response.status,
      );
    }
    return value;
  }

  const required = async <T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (raw: unknown) => T | null,
  ): Promise<T> => (await call(method, path, body, parse)) as T;

  return {
    getWallet: () => call('GET', ROUTES.WALLET, undefined, parseWallet, true),
    ensureWallet: () => required('POST', ROUTES.WALLET, undefined, parseWallet),
    signMessage: (request) =>
      required('POST', ROUTES.SIGN_MESSAGE, request, parseSignature),
    sendTransaction: (request) =>
      required('POST', ROUTES.TRANSACTIONS, request, parseTransaction),
    sendCalls: (request) =>
      required('POST', ROUTES.CALLS, request, parseTransaction),
    getTransaction: (id) =>
      required(
        'GET',
        `${ROUTES.TRANSACTIONS}/${encodeURIComponent(id)}`,
        undefined,
        parseTransaction,
      ),
    exportWallet: (request) =>
      required('POST', ROUTES.WALLET_EXPORT, request, parseExport),
  };
}
