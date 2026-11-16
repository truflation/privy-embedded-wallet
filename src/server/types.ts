import type {
  Address,
  ExportWalletRequest,
  ExportWalletResponse,
  SignMessageRequest,
  SignMessageResponse,
  SignableMessage,
  TransactionRequest,
  TransactionResponse,
} from '../protocol/index';
import type { Logger } from './logger';
import type { WalletStore } from './store';

/**
 * The caller's identity, taken from the host's own verified session.
 * Never build it from request input.
 */
export interface Session {
  /** The subject the host verified. Also the Privy `custom_user_id`. */
  userId: string;
  /** The raw session JWT, forwarded to Privy as the user's authorization. */
  jwt: string;
}

export interface ChainConfig {
  /**
   * Ask Privy to sponsor gas. Sponsorship must also be enabled for this chain
   * in the Privy dashboard, and is not offered on every chain. A sponsored
   * chain needs an `allow` list or an `authorizeTransaction` hook.
   */
  sponsor: boolean;
  /**
   * Transactions on this chain must go to one of `to` (compared without
   * regard to case) and carry at most `maxValue` wei, which defaults to `0n`.
   * Calldata is not inspected; use `authorizeTransaction` for that.
   */
  allow?: { to: readonly Address[]; maxValue?: bigint };
}

/**
 * Host rule run before every send, after the chain's `allow` list. Only
 * `true` allows the transaction; `false`, any other value, a throw or a
 * rejection denies it with `POLICY_DENIED`. `tx` is the validated request.
 */
export type AuthorizeTransaction = (
  session: Session,
  tx: Readonly<TransactionRequest>,
) => boolean | Promise<boolean>;

/** What `authorizeMessage` sees: the checksummed address and the message. */
export interface MessageAuthorizationRequest {
  address: Address;
  message: SignableMessage;
}

/**
 * Host rule run before every untrusted `signMessage`, after the session and
 * account checks. Only `true` allows the signature; `false`, any other value,
 * a throw or a rejection denies it with `POLICY_DENIED`. `request` is the
 * validated request.
 */
export type AuthorizeMessage = (
  session: Session,
  request: Readonly<MessageAuthorizationRequest>,
) => boolean | Promise<boolean>;

/** What `authorizeExport` sees: the checksummed address being exported. */
export interface ExportAuthorizationRequest {
  address: Address;
}

/**
 * Host rule run before every export, after the session and account checks.
 * Export is refused unless this hook is configured and returns exactly
 * `true`; `false`, any other value, a throw or a rejection is
 * `POLICY_DENIED`. An exported key escapes every other host rule, so the
 * hook should require a fresh step-up, such as a code emailed to the user.
 */
export type AuthorizeExport = (
  session: Session,
  request: Readonly<ExportAuthorizationRequest>,
) => boolean | Promise<boolean>;

export interface SignMessageOptions {
  /**
   * Skips `authorizeMessage`. Only for a message the host's own server code
   * constructed. Never derive it from request input: a browser-supplied
   * message signed with `trusted: true` bypasses the hook entirely. The
   * request handler never sets it.
   */
  trusted?: boolean;
}

export interface EmbeddedWalletServiceConfig {
  /** Privy app id. */
  appId: string;
  /** Privy app secret. Server only; never send it to a browser. */
  appSecret: string;
  store: WalletStore;
  /** Chains the wallet may transact on, keyed by EIP-155 chain id. */
  chains: Readonly<Record<number, ChainConfig>>;
  /** Optional host rule every transaction must also pass. */
  authorizeTransaction?: AuthorizeTransaction;
  /**
   * Optional host rule every message signed for a browser request must pass.
   * Skipped only for `signMessage(..., { trusted: true })`.
   */
  authorizeMessage?: AuthorizeMessage;
  /**
   * Required to enable private key export. Without it every export is
   * refused with `POLICY_DENIED`.
   */
  authorizeExport?: AuthorizeExport;
  /**
   * Privy policy ids every wallet must carry. Privy currently allows at most
   * one. New wallets are created with them; a wallet found without them has
   * them attached using the user's JWT, and is refused for signing and
   * sending while that has not succeeded.
   */
  policyIds?: readonly string[];
  /**
   * The JWT claim holding the host user id, compared with `session.userId`
   * on every call. Its value must be a string. Defaults to `sub`.
   */
  userIdClaim?: string;
  /** Receives Privy failure details. Defaults to discarding them. */
  logger?: Logger;
}

export interface WalletResult {
  address: Address;
}

export interface EnsureWalletResult {
  address: Address;
  /** True when this call created the wallet. */
  created: boolean;
}

export interface EmbeddedWalletService {
  /** The stored wallet, or null. Reads the store only. */
  getWallet(session: Session): Promise<WalletResult | null>;
  /** Finds or creates the Privy user and a user-owned wallet. Idempotent. */
  ensureWallet(session: Session): Promise<EnsureWalletResult>;
  /**
   * `personal_sign`. A string message is signed as UTF-8; `{ raw }` as bytes.
   * `request.address` must be the session's wallet, or `ACCOUNT_MISMATCH`.
   * The message must then pass `authorizeMessage`, unless `options.trusted`.
   */
  signMessage(
    session: Session,
    request: SignMessageRequest,
    options?: SignMessageOptions,
  ): Promise<SignMessageResponse>;
  /**
   * Idempotent per `request.requestId`: repeating it returns the original
   * transaction. `request.from` must be the session's wallet.
   */
  sendTransaction(
    session: Session,
    request: TransactionRequest,
  ): Promise<TransactionResponse>;
  /** Rejects ids that do not belong to the session's wallet. */
  getTransaction(session: Session, id: string): Promise<TransactionResponse>;
  /**
   * The wallet's private key, HPKE-encrypted by Privy to
   * `request.recipientPublicKey`. Only the holder of the matching private
   * key, normally the user's browser, can decrypt it. `request.address` must
   * be the session's wallet, and `authorizeExport` must allow the export.
   */
  exportWallet(
    session: Session,
    request: ExportWalletRequest,
  ): Promise<ExportWalletResponse>;
}
