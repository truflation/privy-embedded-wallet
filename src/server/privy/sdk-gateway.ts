import {
  NotFoundError,
  PrivyClient,
  generateAuthorizationSignatures,
  type Wallet,
} from '@privy-io/node';
import { MAX_WALLETS_SCANNED } from '../limits';
import {
  PRIVY_EXPORT_ENCRYPTION,
  type CreateWalletInput,
  type ExportedWallet,
  type PrivyGateway,
  type PrivyTransactionRef,
  type PrivyWalletRef,
  type SendTransactionInput,
  type SentTransaction,
} from './gateway';
import { toUpstreamError } from './upstream-error';

export interface SdkGatewayConfig {
  appId: string;
  appSecret: string;
  /** Override the Privy API URL. Internal, for tests against a mock. */
  apiUrl?: string;
}

/**
 * Privy's production API, the SDK's own default (`environments.production`
 * in `@privy-io/node/client.js`). Passed explicitly because the SDK otherwise
 * reads `PRIVY_API_BASE_URL` from the environment, which would let an
 * environment variable redirect signed wallet requests.
 */
export const PRIVY_API_URL = 'https://api.privy.io';

const CHAIN_TYPE = 'ethereum';

/**
 * A signable request used only to make the SDK exchange a JWT for the user's
 * authorization key. Nothing is sent to this URL: the signature is computed
 * locally and discarded. The SDK caches the exchanged key per JWT, so the
 * real wallet request that follows reuses it without a second exchange.
 */
const AUTHORIZE_PROBE_PATH = '/v1/wallets/authorize-probe';

/** Privy's export endpoint for a wallet, as the SDK builds it. */
const exportPath = (walletId: string) =>
  `/v1/wallets/${encodeURIComponent(walletId)}/export`;

function caip2(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`;
}

function toWalletRef(wallet: Wallet): PrivyWalletRef {
  return {
    id: wallet.id,
    address: wallet.address,
    createdAt: wallet.created_at,
    policyIds: Array.isArray(wallet.policy_ids) ? [...wallet.policy_ids] : [],
  };
}

/** Runs an SDK call and normalizes whatever it throws. */
async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toUpstreamError(error, operation);
  }
}

export function createSdkGateway(config: SdkGatewayConfig): PrivyGateway {
  const apiUrl = config.apiUrl ?? PRIVY_API_URL;
  const privy = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
    apiUrl,
    // Explicit, so `PRIVY_API_LOG` cannot turn on the SDK's request logging,
    // which at debug level prints request and response details.
    logLevel: 'off',
  });

  return {
    async findUserByCustomAuthId(customUserId) {
      try {
        const user = await privy
          .users()
          .getByCustomAuthID({ custom_user_id: customUserId });
        return { id: user.id };
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw toUpstreamError(error, 'users.getByCustomAuthID');
      }
    },

    async createUser(customUserId) {
      const user = await call('users.create', () =>
        privy.users().create({
          linked_accounts: [
            { type: 'custom_auth', custom_user_id: customUserId },
          ],
        }),
      );
      return { id: user.id };
    },

    async listUserWallets(privyUserId) {
      return call('wallets.list', async () => {
        const wallets: PrivyWalletRef[] = [];
        for await (const wallet of privy
          .wallets()
          .list({ user_id: privyUserId, chain_type: CHAIN_TYPE })) {
          wallets.push(toWalletRef(wallet));
          if (wallets.length >= MAX_WALLETS_SCANNED) break;
        }
        return wallets;
      });
    },

    async createUserWallet(input: CreateWalletInput) {
      const wallet = await call('wallets.create', () =>
        privy.wallets().create({
          chain_type: CHAIN_TYPE,
          owner: { user_id: input.privyUserId },
          ...(input.policyIds.length > 0
            ? { policy_ids: [...input.policyIds] }
            : {}),
          idempotency_key: input.idempotencyKey,
        }),
      );
      return toWalletRef(wallet);
    },

    async updateWalletPolicies(walletId, policyIds, jwt) {
      // A user-owned wallet's owner is the user, so the user's JWT is the
      // authorization Privy requires for the update.
      const wallet = await call('wallets.update', () =>
        privy.wallets().update(walletId, {
          policy_ids: [...policyIds],
          authorization_context: { user_jwts: [jwt] },
        }),
      );
      return toWalletRef(wallet);
    },

    async authorize(jwt) {
      await call('wallets.authenticate', () =>
        generateAuthorizationSignatures(privy, {
          authorizationContext: { user_jwts: [jwt] },
          input: {
            version: 1,
            method: 'POST',
            url: `${apiUrl}${AUTHORIZE_PROBE_PATH}`,
            body: {},
            headers: { 'privy-app-id': config.appId },
          },
        }),
      );
    },

    async signMessage(walletId, message, jwt) {
      // Always pass bytes. The SDK treats a string starting with "0x" as hex,
      // which would sign the wrong bytes for a UTF-8 message like "0xabc".
      const { signature } = await call('wallets.rpc.personal_sign', () =>
        privy
          .wallets()
          .ethereum()
          .signMessage(walletId, {
            message,
            authorization_context: { user_jwts: [jwt] },
          }),
      );
      return signature;
    },

    async sendTransaction(
      walletId,
      input: SendTransactionInput,
      jwt,
    ): Promise<SentTransaction> {
      const sent = await call('wallets.rpc.eth_sendTransaction', () =>
        privy
          .wallets()
          .ethereum()
          .sendTransaction(walletId, {
            caip2: caip2(input.chainId),
            ...(input.sponsor ? { sponsor: true } : {}),
            params: {
              transaction: {
                chain_id: input.chainId,
                to: input.to,
                ...(input.data !== undefined ? { data: input.data } : {}),
                ...(input.value !== undefined ? { value: input.value } : {}),
              },
            },
            reference_id: input.referenceId,
            authorization_context: { user_jwts: [jwt] },
            idempotency_key: input.idempotencyKey,
          }),
      );
      return { hash: sent.hash, transactionId: sent.transaction_id };
    },

    async getTransaction(transactionId): Promise<PrivyTransactionRef> {
      const tx = await call('transactions.get', () =>
        privy.transactions().get(transactionId),
      );
      return {
        id: tx.id,
        walletId: tx.wallet_id,
        status: tx.status,
        hash: tx.transaction_hash,
      };
    },

    async exportWallet(
      walletId,
      recipientPublicKey,
      jwt,
    ): Promise<ExportedWallet> {
      // The SDK's `exportPrivateKey` generates its own recipient key and
      // decrypts here, on the host server. This builds the same signed
      // request (`prepareRequest` in `@privy-io/node/lib/authorization.js`)
      // around the browser's key instead, and returns only ciphertext.
      const body = {
        encryption_type: PRIVY_EXPORT_ENCRYPTION,
        recipient_public_key: recipientPublicKey,
        export_seed_phrase: false,
      } as const;
      const exported = await call('wallets.export', async () => {
        const expiry = privy.getRequestExpiry();
        const expiryHeader =
          expiry != null ? { 'privy-request-expiry': String(expiry) } : {};
        const signatures = await generateAuthorizationSignatures(privy, {
          authorizationContext: { user_jwts: [jwt] },
          input: {
            version: 1,
            method: 'POST',
            url: `${apiUrl}${exportPath(walletId)}`,
            body,
            headers: { 'privy-app-id': config.appId, ...expiryHeader },
          },
        });
        return privy.wallets()._export(walletId, {
          ...body,
          'privy-authorization-signature': signatures.join(','),
          ...expiryHeader,
        });
      });
      return {
        ciphertext: exported.ciphertext,
        encapsulatedKey: exported.encapsulated_key,
        encryptionType: exported.encryption_type,
      };
    },
  };
}
