import type { Hex } from '../../protocol/index';

/**
 * The subset of Privy the service uses. The production implementation wraps
 * `@privy-io/node`; unit tests inject a fake. Every method throws
 * `UpstreamError` on failure and nothing else.
 */
export interface PrivyGateway {
  /** The Privy user linked to this custom auth id, or null if none. */
  findUserByCustomAuthId(customUserId: string): Promise<PrivyUserRef | null>;
  /** Creates a Privy user with a `custom_auth` linked account. */
  createUser(customUserId: string): Promise<PrivyUserRef>;
  /** Active Ethereum wallets owned by the Privy user. */
  listUserWallets(privyUserId: string): Promise<PrivyWalletRef[]>;
  /** Creates an Ethereum wallet owned by the Privy user. */
  createUserWallet(input: CreateWalletInput): Promise<PrivyWalletRef>;
  /**
   * Replaces a user-owned wallet's policies, authorized by the owner's JWT.
   * Returns the wallet as Privy reports it after the update.
   */
  updateWalletPolicies(
    walletId: string,
    policyIds: readonly string[],
    jwt: string,
  ): Promise<PrivyWalletRef>;
  /**
   * Proves the JWT to Privy (exchanges it for the user's authorization key)
   * without performing any wallet action. Separating this step lets the
   * service tell a rejected JWT apart from a rejected wallet request.
   */
  authorize(jwt: string): Promise<void>;
  /** `personal_sign` over raw bytes. Returns the signature. */
  signMessage(
    walletId: string,
    message: Uint8Array,
    jwt: string,
  ): Promise<string>;
  sendTransaction(
    walletId: string,
    input: SendTransactionInput,
    jwt: string,
  ): Promise<SentTransaction>;
  /**
   * `wallet_sendCalls` (EIP-5792): the calls in order, as one atomic,
   * sponsored transaction.
   */
  sendCalls(
    walletId: string,
    input: SendCallsInput,
    jwt: string,
  ): Promise<SentCalls>;
  getTransaction(transactionId: string): Promise<PrivyTransactionRef>;
  /**
   * Asks Privy for the wallet's private key, HPKE-encrypted to
   * `recipientPublicKey` (base64 SPKI), authorized by the owner's JWT. The
   * result is ciphertext only; nothing here can decrypt it.
   */
  exportWallet(
    walletId: string,
    recipientPublicKey: string,
    jwt: string,
  ): Promise<ExportedWallet>;
}

/** The only export encryption Privy offers. */
export const PRIVY_EXPORT_ENCRYPTION = 'HPKE';

export interface ExportedWallet {
  /** Base64, as Privy returns it. */
  ciphertext: string;
  /** Base64, as Privy returns it. */
  encapsulatedKey: string;
  /** Privy currently only returns `PRIVY_EXPORT_ENCRYPTION`. */
  encryptionType: string;
}

export interface PrivyUserRef {
  id: string;
}

export interface PrivyWalletRef {
  id: string;
  address: string;
  /** Unix milliseconds. Used to pick the same wallet deterministically. */
  createdAt: number;
  /** Policies Privy enforces on the wallet. */
  policyIds: readonly string[];
}

export interface CreateWalletInput {
  privyUserId: string;
  policyIds: readonly string[];
  /** Deterministic per user, so retries and racing processes dedupe. */
  idempotencyKey: string;
}

export interface SendTransactionInput {
  chainId: number;
  sponsor: boolean;
  to: string;
  data?: Hex;
  value?: Hex;
  /**
   * Deterministic per user and `requestId`, so every retry of one intent,
   * by the client or the SDK, is answered by Privy without sending again.
   */
  idempotencyKey: string;
  /** Privy `reference_id`, also deterministic per user and `requestId`. */
  referenceId: string;
}

export interface SendCallsInput {
  chainId: number;
  calls: readonly { to: string; data?: Hex; value?: Hex }[];
  /**
   * The same key a single send with this user and `requestId` would use, so
   * one intent can never produce both a single send and a batch. Privy's
   * `wallet_sendCalls` takes no `reference_id`, so this is the only
   * deduplication for a batch.
   */
  idempotencyKey: string;
}

export interface SentCalls {
  /** Privy's transaction id for the batch. */
  transactionId: string | undefined;
}

export interface SentTransaction {
  /** May be empty for sponsored transactions that are not yet broadcast. */
  hash: string;
  transactionId: string | undefined;
}

/** Privy transaction statuses as of `@privy-io/node` 0.39.0. */
export type PrivyTransactionStatus =
  | 'broadcasted'
  | 'confirmed'
  | 'execution_reverted'
  | 'failed'
  | 'replaced'
  | 'finalized'
  | 'provider_error'
  | 'pending';

export interface PrivyTransactionRef {
  id: string;
  walletId: string;
  /** Typed as string because Privy may add statuses. */
  status: PrivyTransactionStatus | (string & {});
  hash: string | null;
  /** CAIP-2 chain id, for example `eip155:1`. */
  caip2?: string;
}
