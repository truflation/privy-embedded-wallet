/**
 * Wire protocol shared by the server handlers and the browser client.
 * This module is types and constants only. It must stay free of runtime
 * dependencies so both sides can import it.
 */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** Route paths, relative to the base path the host mounts the handler on. */
export const ROUTES = {
  /** GET returns the wallet or 404. POST creates it if missing (idempotent). */
  WALLET: '/wallet',
  /** POST. Signs a message with personal_sign. */
  SIGN_MESSAGE: '/sign-message',
  /**
   * POST submits a transaction. GET `${TRANSACTIONS}/:id` reads the status of
   * a submitted transaction.
   */
  TRANSACTIONS: '/transactions',
  /**
   * POST submits a batch of calls as one atomic, sponsored transaction
   * (EIP-5792 `wallet_sendCalls`). Its status is read like any other
   * transaction, with GET `${TRANSACTIONS}/:id`.
   */
  CALLS: '/calls',
  /**
   * POST. Returns the wallet's private key, HPKE-encrypted to a public key
   * the browser generated. The host server cannot decrypt it.
   */
  WALLET_EXPORT: '/wallet/export',
} as const;

export const ERROR_CODE = {
  /** No valid host session. The user must sign in. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Privy rejected the session token (usually expired). Refresh it and retry. */
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  /** The user has no embedded wallet yet. */
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  /** The request failed validation, or its origin is not allowed. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The chain is not configured on the server. */
  CHAIN_NOT_SUPPORTED: 'CHAIN_NOT_SUPPORTED',
  /**
   * The chain is configured, but batched calls are not accepted on it. Only
   * chains with `sponsor: true` take batches.
   */
  BATCH_NOT_SUPPORTED: 'BATCH_NOT_SUPPORTED',
  /** A wallet policy or the host's transaction rules rejected the request. */
  POLICY_DENIED: 'POLICY_DENIED',
  /**
   * The session's wallet is not the address the client expected, usually
   * because a different user signed in. The client must drop cached state.
   */
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  /** The wallet cannot pay for the transaction. */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** The transaction does not exist or belongs to another user. */
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  /**
   * Privy or the RPC failed. Reads are safe to retry. A send is safe to retry
   * only with the same `requestId`.
   */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** Every non-2xx response has this body. */
export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

export interface WalletResponse {
  address: Address;
  /** True only on the POST that created the wallet. */
  created?: boolean;
  /**
   * Chains on which the server accepts `POST ${ROUTES.CALLS}`, ascending.
   * Absent from servers older than 0.2.0, which accept no batches.
   */
  batchChainIds?: number[];
}

export type SignableMessage = string | { raw: Hex };

export interface SignMessageRequest {
  /** The address the client believes it is signing with. */
  address: Address;
  message: SignableMessage;
}
export interface SignMessageResponse {
  signature: Hex;
}

/**
 * Export uses HPKE base mode with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
 * ChaCha20-Poly1305, and empty `info` and `aad`: the suite `@privy-io/node`
 * uses for its own export.
 */
export interface ExportWalletRequest {
  /** The address the client believes it is exporting. */
  address: Address;
  /**
   * The browser's ephemeral P-256 public key, as base64 of its DER
   * SubjectPublicKeyInfo (91 bytes), the format `@privy-io/node` sends.
   */
  recipientPublicKey: string;
}
export interface ExportWalletResponse {
  /** Base64 HPKE ciphertext of the private key. Opaque to the host server. */
  ciphertext: string;
  /** Base64 HPKE encapsulated key (an uncompressed P-256 point). */
  encapsulatedKey: string;
}

export interface TransactionRequest {
  /**
   * Client-generated UUID, created once per user intent and reused on every
   * retry of that intent. The server deduplicates on it, so a retried request
   * can never send twice.
   */
  requestId: string;
  /** The address the client believes it is sending from. */
  from: Address;
  chainId: number;
  to: Address;
  data?: Hex;
  /** Wei, as a hex quantity. */
  value?: Hex;
}

/** Most calls one batch may carry. */
export const MAX_BATCH_CALLS = 10;

/** One call inside a batch: the fields of a transaction that vary per call. */
export interface BatchCall {
  to: Address;
  data?: Hex;
  /** Wei, as a hex quantity. */
  value?: Hex;
}

/**
 * A batch of calls sent atomically from one wallet on one chain. Every call
 * passes the same server rules as a single transaction; if any is refused,
 * nothing is sent.
 */
export interface SendCallsRequest {
  /** As on `TransactionRequest`: one UUID per user intent, reused on retry. */
  requestId: string;
  /** The address the client believes it is sending from. */
  from: Address;
  chainId: number;
  /** Between 1 and `MAX_BATCH_CALLS` calls, executed in order. */
  calls: BatchCall[];
}

export const TRANSACTION_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
} as const;
export type TransactionStatus =
  (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

export interface TransactionResponse {
  /** Opaque id for polling. Stable for the life of the transaction. */
  id: string;
  status: TransactionStatus;
  /**
   * The on-chain transaction hash. May be absent while a sponsored transaction
   * is still being bundled, so clients poll until it appears.
   */
  hash?: Hex;
  /**
   * The chain the transaction was sent on, when Privy reports it. Set by
   * `GET ${ROUTES.TRANSACTIONS}/:id` from 0.2.0; absent on submit responses.
   */
  chainId?: number;
}
