import { getAddress, isHex } from 'viem';
import {
  ERROR_CODE,
  TRANSACTION_STATUS,
  type Address,
  type ExportWalletResponse,
  type Hex,
  type TransactionRequest,
  type TransactionResponse,
} from '../protocol/index';
import { passesHook, readAuthorizeHook } from './authorize-hooks';
import { walletError } from './errors';
import { mapUpstreamError, type UpstreamStep } from './error-mapping';
import { sendIdempotencyKey, sendReferenceId } from './idempotency';
import { silentLogger, type Logger } from './logger';
import {
  AEAD_TAG_BYTES,
  MAX_EXPORT_CIPHERTEXT_BYTES,
  MAX_POLICY_IDS,
  P256_POINT_BYTES,
} from './limits';
import { attachPolicies, carriesPolicies } from './policy-attachment';
import {
  PRIVY_EXPORT_ENCRYPTION,
  type ExportedWallet,
  type PrivyGateway,
} from './privy/gateway';
import { createSdkGateway } from './privy/sdk-gateway';
import { UpstreamError } from './privy/upstream-error';
import { provisionWallet } from './provisioning';
import { createSessionCheck, readUserIdClaim } from './session';
import type { WalletRecord, WalletStore } from './store';
import {
  passesAllowList,
  readBatchChainIds,
  readChains,
  type ChainRules,
} from './transaction-rules';
import {
  isKnownPrivyStatus,
  mapTransactionStatus,
  toTransactionHash,
} from './transaction-status';
import type {
  EmbeddedWalletService,
  EmbeddedWalletServiceConfig,
  EnsureWalletResult,
  Session,
  TransactionAuthorizationRequest,
} from './types';
import {
  decodeCanonicalBase64,
  parseExportWalletRequest,
  parseSendCallsRequest,
  parseSignMessageRequest,
  parseTransactionId,
  parseTransactionRequest,
} from './validation';

/** Service configuration minus the Privy credentials, for an injected gateway. */
export type ServiceOptions = Omit<
  EmbeddedWalletServiceConfig,
  'appId' | 'appSecret'
>;

export function createEmbeddedWalletService(
  config: EmbeddedWalletServiceConfig,
): EmbeddedWalletService {
  if (typeof config.appId !== 'string' || config.appId.length === 0) {
    throw new TypeError('appId is required.');
  }
  if (typeof config.appSecret !== 'string' || config.appSecret.length === 0) {
    throw new TypeError('appSecret is required.');
  }
  const { appId, appSecret, ...options } = config;
  return createServiceWithGateway(
    options,
    createSdkGateway({ appId, appSecret }),
  );
}

function readPolicyIds(policyIds: readonly string[] | undefined): string[] {
  if (policyIds === undefined) return [];
  if (
    !Array.isArray(policyIds) ||
    policyIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new TypeError('policyIds must be an array of policy id strings.');
  }
  if (policyIds.length > MAX_POLICY_IDS) {
    throw new TypeError(
      `Privy allows at most ${MAX_POLICY_IDS} policy per wallet.`,
    );
  }
  return [...policyIds];
}

function readStore(store: WalletStore): WalletStore {
  if (typeof store?.get !== 'function' || typeof store?.put !== 'function') {
    throw new TypeError('store must implement get and put.');
  }
  return store;
}

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Builds the service around any `PrivyGateway`. Internal: the public entry
 * point is `createEmbeddedWalletService`, which supplies the SDK gateway.
 */
export function createServiceWithGateway(
  options: ServiceOptions,
  gateway: PrivyGateway,
): EmbeddedWalletService {
  const store = readStore(options.store);
  const authorizeHook = readAuthorizeHook(
    options.authorizeTransaction,
    'authorizeTransaction',
  );
  const messageHook = readAuthorizeHook(
    options.authorizeMessage,
    'authorizeMessage',
  );
  const exportHook = readAuthorizeHook(
    options.authorizeExport,
    'authorizeExport',
  );
  const chains = readChains(options.chains, authorizeHook !== null);
  const batchChainIds = readBatchChainIds(chains);
  const policyIds = readPolicyIds(options.policyIds);
  const logger: Logger = options.logger ?? silentLogger;
  const assertSession = createSessionCheck(
    readUserIdClaim(options.userIdClaim),
    logger,
  );

  // One provisioning run per user at a time in this process.
  const inflight = new Map<string, Promise<EnsureWalletResult>>();

  async function guard<T>(step: UpstreamStep, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw mapUpstreamError(error, step, logger);
      }
      throw error;
    }
  }

  async function requireRecord(
    session: Session,
    code:
      | typeof ERROR_CODE.WALLET_NOT_FOUND
      | typeof ERROR_CODE.TRANSACTION_NOT_FOUND,
  ): Promise<WalletRecord> {
    const record = await store.get(session.userId);
    if (!record) throw walletError(code);
    return record;
  }

  /** Rule 2: the client must name the wallet it believes it is using. */
  function assertAccount(record: WalletRecord, expected: Address): void {
    if (!sameAddress(record.address, expected)) {
      throw walletError(ERROR_CODE.ACCOUNT_MISMATCH);
    }
  }

  /**
   * Rule 3: the host's rules run before anything reaches Privy. Every
   * transaction must pass the chain's allow list, then the hook, in order.
   * The allow list is checked for all of them before the hook sees any, so
   * the hook never runs for a batch the static rules already refuse. The
   * first refusal ends the check: a batch is all or nothing.
   */
  async function authorizeTransactions(
    session: Session,
    chain: ChainRules,
    txs: readonly TransactionRequest[],
    batched: boolean,
  ): Promise<void> {
    for (const [index, tx] of txs.entries()) {
      if (!passesAllowList(chain, tx)) {
        logger.warn('Transaction outside the chain allow list was refused', {
          chainId: tx.chainId,
          ...(batched ? { index } : {}),
        });
        throw walletError(ERROR_CODE.POLICY_DENIED);
      }
    }
    for (const [index, tx] of txs.entries()) {
      const input: TransactionAuthorizationRequest = batched
        ? { ...tx, batch: Object.freeze({ index, size: txs.length }) }
        : { ...tx };
      if (
        !(await passesHook(
          authorizeHook,
          { name: 'authorizeTransaction', subject: 'transaction' },
          session,
          Object.freeze(input),
          logger,
        ))
      ) {
        throw walletError(ERROR_CODE.POLICY_DENIED);
      }
    }
  }

  /**
   * Rule 5: a wallet without the configured policies is never used. The
   * attachment is retried here, with the user's JWT, so a wallet whose
   * attachment failed during `ensureWallet`, or one stored before
   * `policyIds` was set, heals on its next use. Runs after the JWT
   * exchange, so a 401 here is still reported as `REAUTH_REQUIRED`.
   */
  async function ensurePolicies(
    record: WalletRecord,
    jwt: string,
  ): Promise<void> {
    if (carriesPolicies(record.policyIds, policyIds)) return;
    let attached: readonly string[] | null;
    try {
      attached = await attachPolicies(gateway, record.walletId, policyIds, jwt);
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      if (error.kind === 'unauthorized') {
        throw mapUpstreamError(error, 'sign', logger);
      }
      logger.error(
        'Wallet lacks the configured policy and attaching it failed; refusing',
        {
          walletId: record.walletId,
          operation: error.operation,
          kind: error.kind,
          status: error.status,
          detail: error.detail,
        },
      );
      throw walletError(ERROR_CODE.POLICY_DENIED);
    }
    if (!attached) {
      logger.error(
        'Wallet lacks the configured policy and Privy did not attach it; refusing',
        { walletId: record.walletId },
      );
      throw walletError(ERROR_CODE.POLICY_DENIED);
    }
    await store.put({ ...record, policyIds: [...attached] });
  }

  return {
    async getWallet(session) {
      assertSession(session);
      const record = await store.get(session.userId);
      return record ? { address: record.address } : null;
    },

    ensureWallet(session) {
      try {
        assertSession(session);
      } catch (error) {
        return Promise.reject(error);
      }
      const { userId } = session;
      let pending = inflight.get(userId);
      if (!pending) {
        pending = provisionWallet(
          { gateway, store, policyIds, logger },
          session,
        ).finally(() => inflight.delete(userId));
        inflight.set(userId, pending);
      }
      // A copy per caller, so no caller can mutate another's result.
      return pending.then((result) => ({ ...result }));
    },

    async signMessage(session, request, options) {
      assertSession(session);
      const { request: parsed, bytes } = parseSignMessageRequest(request);
      const record = await requireRecord(session, ERROR_CODE.WALLET_NOT_FOUND);
      assertAccount(record, parsed.address);
      // Rule 11: only a literal `true` from host server code skips the hook.
      if (options?.trusted !== true) {
        const input = Object.freeze({
          address: getAddress(parsed.address),
          message:
            typeof parsed.message === 'string'
              ? parsed.message
              : Object.freeze({ ...parsed.message }),
        });
        if (
          !(await passesHook(
            messageHook,
            { name: 'authorizeMessage', subject: 'signature' },
            session,
            input,
            logger,
          ))
        ) {
          throw walletError(ERROR_CODE.POLICY_DENIED);
        }
      }
      await guard('authorize', () => gateway.authorize(session.jwt));
      await ensurePolicies(record, session.jwt);
      const signature = await guard('sign', () =>
        gateway.signMessage(record.walletId, bytes, session.jwt),
      );
      if (!isHex(signature, { strict: true }) || signature.length <= 2) {
        logger.error('Privy returned a malformed signature');
        throw walletError(ERROR_CODE.PROVIDER_ERROR);
      }
      return { signature };
    },

    async sendTransaction(session, request) {
      assertSession(session);
      const parsed = parseTransactionRequest(request);
      // Checksummed, so the hook can compare addresses as strings and wallet
      // policies, which compare strings, match the builder's output.
      const tx = {
        ...parsed,
        from: getAddress(parsed.from),
        to: getAddress(parsed.to),
      };
      const chain = chains.get(tx.chainId);
      if (!chain) throw walletError(ERROR_CODE.CHAIN_NOT_SUPPORTED);
      const record = await requireRecord(session, ERROR_CODE.WALLET_NOT_FOUND);
      assertAccount(record, tx.from);
      await authorizeTransactions(session, chain, [tx], false);
      await guard('authorize', () => gateway.authorize(session.jwt));
      await ensurePolicies(record, session.jwt);
      // Rule 1. Both keys depend only on the user and the requestId, never on
      // the body. A retry of the same intent is answered from Privy's
      // idempotency cache with the original transaction, through the same
      // path below. A reused requestId with a different body cannot send a
      // second transaction either: within Privy's idempotency window the key
      // matches, and after it the reference id does (Privy documents it as
      // unique per app). What Privy answers in those cases, and to a
      // duplicate that arrives while the first is in flight, is not
      // specified by the SDK; any client error there maps to PROVIDER_ERROR.
      const sent = await guard('send', () =>
        gateway.sendTransaction(
          record.walletId,
          {
            chainId: tx.chainId,
            sponsor: chain.sponsor,
            to: tx.to,
            ...(tx.data !== undefined ? { data: tx.data } : {}),
            ...(tx.value !== undefined ? { value: tx.value } : {}),
            idempotencyKey: sendIdempotencyKey(session.userId, tx.requestId),
            referenceId: sendReferenceId(session.userId, tx.requestId),
          },
          session.jwt,
        ),
      );
      const hash = toTransactionHash(sent.hash);
      const id = sent.transactionId || hash;
      if (!id) {
        // Privy accepted the request but returned nothing to track it by.
        // The transaction may still land; a retry with the same requestId
        // is answered from Privy's idempotency cache, never sent again.
        logger.error('Privy returned neither a transaction id nor a hash', {
          chainId: tx.chainId,
          walletId: record.walletId,
        });
        throw walletError(ERROR_CODE.PROVIDER_ERROR);
      }
      // Pending even on a replay of a transaction that has since settled:
      // `getTransaction` is the source of truth for status.
      return withHash({ id, status: TRANSACTION_STATUS.PENDING }, hash);
    },

    async sendCalls(session, request) {
      assertSession(session);
      const parsed = parseSendCallsRequest(request);
      const chain = chains.get(parsed.chainId);
      if (!chain) throw walletError(ERROR_CODE.CHAIN_NOT_SUPPORTED);
      // Without sponsorship the wallet is a plain EOA, which cannot execute
      // a batch atomically. Refused before anything else is looked up.
      if (!chain.sponsor) throw walletError(ERROR_CODE.BATCH_NOT_SUPPORTED);
      const from = getAddress(parsed.from);
      const record = await requireRecord(session, ERROR_CODE.WALLET_NOT_FOUND);
      assertAccount(record, from);
      // Each call is checked as the transaction it would be on its own,
      // checksummed like a single send.
      const txs: TransactionRequest[] = parsed.calls.map((call) => ({
        requestId: parsed.requestId,
        from,
        chainId: parsed.chainId,
        to: getAddress(call.to),
        ...(call.data !== undefined ? { data: call.data } : {}),
        ...(call.value !== undefined ? { value: call.value } : {}),
      }));
      await authorizeTransactions(session, chain, txs, true);
      await guard('authorize', () => gateway.authorize(session.jwt));
      await ensurePolicies(record, session.jwt);
      // Rule 1, with the single send's idempotency key: one requestId can
      // produce at most one send, single or batch. Privy's wallet_sendCalls
      // takes no reference_id, so deduplication lasts only for Privy's
      // idempotency window (24 hours), not beyond it.
      const sent = await guard('send', () =>
        gateway.sendCalls(
          record.walletId,
          {
            chainId: parsed.chainId,
            calls: txs.map(({ to, data, value }) => ({
              to,
              ...(data !== undefined ? { data } : {}),
              ...(value !== undefined ? { value } : {}),
            })),
            idempotencyKey: sendIdempotencyKey(
              session.userId,
              parsed.requestId,
            ),
          },
          session.jwt,
        ),
      );
      if (!sent.transactionId) {
        logger.error('Privy returned no transaction id for a batch', {
          chainId: parsed.chainId,
          walletId: record.walletId,
        });
        throw walletError(ERROR_CODE.PROVIDER_ERROR);
      }
      return { id: sent.transactionId, status: TRANSACTION_STATUS.PENDING };
    },

    async getTransaction(session, id) {
      assertSession(session);
      const transactionId = parseTransactionId(id);
      const record = await requireRecord(
        session,
        ERROR_CODE.TRANSACTION_NOT_FOUND,
      );
      let tx;
      try {
        tx = await gateway.getTransaction(transactionId);
      } catch (error) {
        if (
          error instanceof UpstreamError &&
          (error.kind === 'not_found' || error.kind === 'rejected')
        ) {
          throw walletError(ERROR_CODE.TRANSACTION_NOT_FOUND);
        }
        throw error instanceof UpstreamError
          ? mapUpstreamError(error, 'read', logger)
          : error;
      }
      // Invariant 3: a transaction is visible only to the owner of the wallet
      // that sent it. Privy's transaction carries the sending wallet's id,
      // which must match the session user's stored wallet. Another user's
      // transaction is reported exactly like a missing one.
      if (tx.walletId !== record.walletId) {
        logger.warn('Transaction lookup for another wallet was refused', {
          walletId: record.walletId,
        });
        throw walletError(ERROR_CODE.TRANSACTION_NOT_FOUND);
      }
      if (!isKnownPrivyStatus(tx.status)) {
        logger.warn('Unknown Privy transaction status; reporting pending', {
          status: tx.status,
        });
      }
      // Every status, failed included, carries the hash when Privy has one.
      const chainId = chainIdFromCaip2(tx.caip2);
      return withHash(
        {
          id: transactionId,
          status: mapTransactionStatus(tx.status),
          ...(chainId !== undefined ? { chainId } : {}),
        },
        toTransactionHash(tx.hash),
      );
    },

    batchChainIds,

    async exportWallet(session, request) {
      assertSession(session);
      const parsed = parseExportWalletRequest(request);
      const record = await requireRecord(session, ERROR_CODE.WALLET_NOT_FOUND);
      assertAccount(record, parsed.address);
      // Rule 12: deny by default. An exported key escapes every host rule.
      if (!exportHook) {
        logger.warn('Wallet export refused: authorizeExport is not configured');
        throw walletError(ERROR_CODE.POLICY_DENIED);
      }
      if (
        !(await passesHook(
          exportHook,
          { name: 'authorizeExport', subject: 'export' },
          session,
          Object.freeze({ address: getAddress(parsed.address) }),
          logger,
        ))
      ) {
        throw walletError(ERROR_CODE.POLICY_DENIED);
      }
      // No policy check (rule 5): Privy policies govern signing, and the
      // exported key is beyond them either way.
      await guard('authorize', () => gateway.authorize(session.jwt));
      const exported = await guard('export', () =>
        gateway.exportWallet(
          record.walletId,
          parsed.recipientPublicKey,
          session.jwt,
        ),
      );
      const response = toExportResponse(exported);
      if (!response) {
        // Only the shape is logged: never the ciphertext or the keys.
        logger.error('Privy returned a malformed export response');
        throw walletError(ERROR_CODE.PROVIDER_ERROR);
      }
      logger.warn('Wallet private key exported', { walletId: record.walletId });
      return response;
    },
  };
}

/**
 * Checks the shape of Privy's export answer without being able to decrypt
 * it, and passes the base64 strings through unchanged.
 */
function toExportResponse(
  exported: ExportedWallet,
): ExportWalletResponse | null {
  if (exported.encryptionType !== PRIVY_EXPORT_ENCRYPTION) return null;
  const enc = decodeCanonicalBase64(exported.encapsulatedKey);
  const ciphertext = decodeCanonicalBase64(exported.ciphertext);
  if (
    !enc ||
    enc.length !== P256_POINT_BYTES ||
    enc[0] !== 0x04 ||
    !ciphertext ||
    ciphertext.length <= AEAD_TAG_BYTES ||
    ciphertext.length > MAX_EXPORT_CIPHERTEXT_BYTES
  ) {
    return null;
  }
  return {
    ciphertext: exported.ciphertext,
    encapsulatedKey: exported.encapsulatedKey,
  };
}

/** The chain id of an `eip155:<id>` CAIP-2 string, or undefined. */
function chainIdFromCaip2(caip2: string | undefined): number | undefined {
  const match = /^eip155:([1-9][0-9]{0,15})$/.exec(caip2 ?? '');
  if (!match) return undefined;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? chainId : undefined;
}

function withHash(
  response: TransactionResponse,
  hash: Hex | undefined,
): TransactionResponse {
  return hash ? { ...response, hash } : response;
}
