# API reference

Every public export of `@truflation/privy-embedded-wallet`, by entry point.
The package is pre-1.0, so signatures can change between minor versions.

| Entry                                      | Runs in | Use                                                       |
| ------------------------------------------ | ------- | --------------------------------------------------------- |
| `@truflation/privy-embedded-wallet/server` | Node    | Wallet service, request handler, policy builder, store.   |
| `@truflation/privy-embedded-wallet/client` | Browser | HTTP client, EIP-1193 provider, key export helper.        |
| `@truflation/privy-embedded-wallet/wagmi`  | Browser | wagmi connector. The only entry that needs `@wagmi/core`. |
| `@truflation/privy-embedded-wallet/vue`    | Browser | Headless Vue 3 composable.                                |

`/server` and `/client` both re-export the [protocol](#protocol) (wire types
and constants). `/vue` does not.

For a task-oriented walk-through see the [integration guide](integration-guide.md).

## Contents

- [Protocol](#protocol)
- [Server](#server)
  - [createEmbeddedWalletService](#createembeddedwalletservice)
  - [EmbeddedWalletService methods](#embeddedwalletservice)
  - [Session](#session)
  - [ChainConfig and AuthorizeTransaction](#chainconfig-and-authorizetransaction)
  - [AuthorizeMessage](#authorizemessage)
  - [AuthorizeExport](#authorizeexport)
  - [WalletStore, WalletRecord, createMemoryWalletStore](#walletstore-walletrecord-creatememorywalletstore)
  - [createRequestHandler](#createrequesthandler)
  - [buildWalletPolicy](#buildwalletpolicy)
  - [EmbeddedWalletError](#embeddedwalleterror)
  - [Logger](#logger)
- [Client](#client)
  - [createEmbeddedWalletClient](#createembeddedwalletclient)
  - [exportPrivateKey](#exportprivatekey)
  - [createEmbeddedProvider](#createembeddedprovider)
  - [Errors](#client-errors)
- [Wagmi](#wagmi)
  - [embeddedWallet](#embeddedwallet)
  - [getEmbeddedWalletConnector](#getembeddedwalletconnector)
- [Vue](#vue)

## Protocol

Exported from `/server` and `/client`. Types and constants only.

```ts
type Hex = `0x${string}`;
type Address = `0x${string}`;
```

### `ROUTES`

Route paths relative to the handler's `basePath`.

```ts
const ROUTES = {
  WALLET: '/wallet', // GET: wallet or 404. POST: create if missing.
  SIGN_MESSAGE: '/sign-message', // POST
  TRANSACTIONS: '/transactions', // POST submit. GET /transactions/:id status.
  WALLET_EXPORT: '/wallet/export', // POST. HPKE-encrypted private key.
} as const;
```

### `ERROR_CODE` and `ErrorCode`

```ts
const ERROR_CODE = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CHAIN_NOT_SUPPORTED: 'CHAIN_NOT_SUPPORTED',
  POLICY_DENIED: 'POLICY_DENIED',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
} as const;
type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
```

HTTP status, EIP-1193 code and handling advice for each are in the
[error table](integration-guide.md#error-codes).

### Wire types

```ts
interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

interface WalletResponse {
  address: Address;
  created?: boolean; // true only on the POST that created the wallet
}

type SignableMessage = string | { raw: Hex };
interface SignMessageRequest {
  address: Address; // the address the client believes it signs with
  message: SignableMessage; // string: UTF-8. { raw }: bytes
}
interface SignMessageResponse {
  signature: Hex;
}

interface TransactionRequest {
  requestId: string; // UUID, once per user intent, reused on every retry
  from: Address; // the address the client believes it sends from
  chainId: number;
  to: Address;
  data?: Hex;
  value?: Hex; // wei, canonical hex quantity (0x0, 0x1a, no leading zeros)
}

interface ExportWalletRequest {
  address: Address; // the address the client believes it exports
  recipientPublicKey: string; // base64 P-256 SubjectPublicKeyInfo, 91 bytes
}
interface ExportWalletResponse {
  ciphertext: string; // base64 HPKE ciphertext; the host cannot open it
  encapsulatedKey: string; // base64 HPKE encapsulated key, 65 bytes
}

const TRANSACTION_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
} as const;
type TransactionStatus =
  (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

interface TransactionResponse {
  id: string; // opaque, for polling
  status: TransactionStatus;
  hash?: Hex; // may be absent while a sponsored send is bundled
}
```

Request validation (applies to the handler and to direct service calls):

- Unknown fields are rejected.
- Addresses must be valid; a mixed-case address must carry a correct EIP-55
  checksum.
- `chainId` is a positive integer. `requestId` is a UUID in 8-4-4-4-12 form.
- `value` is a canonical hex quantity up to the uint256 maximum.
- `data` is even-length hex up to 64 KiB. A message is at most 16 KiB (UTF-8
  or raw), must not be empty, and a string must be valid Unicode.
- `recipientPublicKey` is standard padded base64 that decodes to exactly 91
  bytes: the DER SubjectPublicKeyInfo header for an uncompressed P-256 key
  followed by the point. A raw point, base64url, unpadded or non-canonical
  base64 is rejected.

## Server

```ts
import { ... } from '@truflation/privy-embedded-wallet/server';
```

Requires Node 22 or later.

### createEmbeddedWalletService

```ts
function createEmbeddedWalletService(
  config: EmbeddedWalletServiceConfig,
): EmbeddedWalletService;
```

```ts
interface EmbeddedWalletServiceConfig {
  appId: string; // Privy app id
  appSecret: string; // Privy app secret. Server only.
  store: WalletStore;
  chains: Readonly<Record<number, ChainConfig>>;
  authorizeTransaction?: AuthorizeTransaction;
  authorizeMessage?: AuthorizeMessage;
  authorizeExport?: AuthorizeExport; // required to enable export
  policyIds?: readonly string[]; // at most one
  userIdClaim?: string; // default 'sub'
  logger?: Logger; // default: discard
}
```

Throws `TypeError` at creation for: empty `appId` or `appSecret`; a `store`
without `get` and `put`; `chains` not an object; a chain id that is not a
positive integer; `sponsor` not a boolean; an `allow.to` that is empty or has an
invalid address; `allow.maxValue` that is not a non-negative bigint; a
`sponsor: true` chain with neither an `allow` list nor an
`authorizeTransaction`; `authorizeTransaction`, `authorizeMessage` or
`authorizeExport` not a function; `policyIds` that
is not an array of non-empty strings, or has more than one entry; an empty
`userIdClaim`.

The Privy client inside is created with logging off and the production API
URL fixed.

```ts
const service = createEmbeddedWalletService({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
  store,
  chains: { 11155111: { sponsor: false } },
  logger: console,
});
```

### EmbeddedWalletService

All methods take a [`Session`](#session) first. Each begins by checking that the
session is well formed and that the JWT's `userIdClaim` equals
`session.userId`; if not, it throws `UNAUTHENTICATED`. Every failure is an
[`EmbeddedWalletError`](#embeddedwalleterror).

```ts
interface EmbeddedWalletService {
  getWallet(session: Session): Promise<WalletResult | null>;
  ensureWallet(session: Session): Promise<EnsureWalletResult>;
  signMessage(
    session: Session,
    request: SignMessageRequest,
    options?: SignMessageOptions,
  ): Promise<SignMessageResponse>;
  sendTransaction(
    session: Session,
    request: TransactionRequest,
  ): Promise<TransactionResponse>;
  getTransaction(session: Session, id: string): Promise<TransactionResponse>;
  exportWallet(
    session: Session,
    request: ExportWalletRequest,
  ): Promise<ExportWalletResponse>;
}
interface WalletResult {
  address: Address;
}
interface EnsureWalletResult {
  address: Address;
  created: boolean;
}
interface SignMessageOptions {
  trusted?: boolean; // skips authorizeMessage; server-built messages only
}
```

| Method                                | Returns                            | Errors                                                                                                                             |
| ------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `getWallet(session)`                  | `{ address }` or `null`            | `UNAUTHENTICATED`. Reads the store only, never calls Privy.                                                                        |
| `ensureWallet(session)`               | `{ address, created }`             | `UNAUTHENTICATED`, `PROVIDER_ERROR`. Finds or creates the Privy user and wallet. See below.                                        |
| `signMessage(session, req, options?)` | `{ signature }`                    | `UNAUTHENTICATED`, `INVALID_REQUEST`, `WALLET_NOT_FOUND`, `ACCOUNT_MISMATCH`, `REAUTH_REQUIRED`, `POLICY_DENIED`, `PROVIDER_ERROR` |
| `sendTransaction(session, req)`       | `{ id, status: 'pending', hash? }` | the above, plus `CHAIN_NOT_SUPPORTED`, `INSUFFICIENT_FUNDS`                                                                        |
| `getTransaction(session, id)`         | `{ id, status, hash? }`            | `UNAUTHENTICATED`, `INVALID_REQUEST` (bad id), `TRANSACTION_NOT_FOUND`, `PROVIDER_ERROR`                                           |
| `exportWallet(session, req)`          | `{ ciphertext, encapsulatedKey }`  | `UNAUTHENTICATED`, `INVALID_REQUEST`, `WALLET_NOT_FOUND`, `ACCOUNT_MISMATCH`, `POLICY_DENIED`, `REAUTH_REQUIRED`, `PROVIDER_ERROR` |

Details:

- `ensureWallet` checks the store first, then looks the user up in Privy by
  your user id, and only then creates. It is safe to call concurrently: calls
  for the same user in one process share one run. A found or created wallet is
  written to the store. If `policyIds` is set and the wallet lacks them, the
  policy is attached with the user's JWT; if that fails the record is stored
  with the policies the wallet really has, and sign and send refuse the wallet
  until a later attempt succeeds.
- `signMessage` checks `request.address` against the stored wallet
  (`ACCOUNT_MISMATCH`), runs the `authorizeMessage` hook (`POLICY_DENIED`),
  exchanges the JWT with Privy, ensures the policy, signs with
  `personal_sign`, and checks the signature is well-formed hex. The hook is
  skipped only when `options.trusted` is exactly `true`. Pass it only for a
  message your own server code built, never based on request input. The
  request handler never passes it.
- `sendTransaction` runs, in order: validation, chain lookup
  (`CHAIN_NOT_SUPPORTED`), wallet lookup, `from` check, the chain `allow` list,
  the `authorizeTransaction` hook (both `POLICY_DENIED`), then the JWT
  exchange, policy check and the Privy send. It is idempotent per
  `requestId`. The returned status is always `pending`; the `hash` is present
  when Privy already had one. Use `getTransaction` for the outcome.
- `getTransaction` loads the transaction by id from Privy and returns it only if
  it was sent by the session user's wallet. Another user's transaction, an
  unknown id, and a user with no wallet all give `TRANSACTION_NOT_FOUND`. It
  maps Privy statuses as described in
  [status values](integration-guide.md#status-values) and includes the `hash`
  whenever Privy has one, failed or not.
- `exportWallet` runs, in order: validation, wallet lookup, `address` check,
  then `authorizeExport` (`POLICY_DENIED`, and always `POLICY_DENIED` when the
  hook is not configured), the JWT exchange, and Privy's export with
  `encryption_type: 'HPKE'` to `request.recipientPublicKey`. It does not run
  the policy check: Privy policies govern signing, and an exported key is
  beyond them. The answer is checked for shape only (base64, a 65-byte
  encapsulated key, a bounded ciphertext) and passed through unread. Each
  successful export is logged at `warn` with the wallet id; the ciphertext
  and keys are never logged. Browsers should call it through
  [`exportPrivateKey`](#exportprivatekey).

### Session

```ts
interface Session {
  userId: string; // the subject your host verified; also the Privy custom_user_id
  jwt: string; // the raw session JWT, forwarded to Privy as the user's consent
}
```

Build it only from your own verified session, never from request input.
`userId` is at most 256 characters and the JWT at most 16 KiB.

### ChainConfig and AuthorizeTransaction

```ts
interface ChainConfig {
  sponsor: boolean;
  allow?: { to: readonly Address[]; maxValue?: bigint }; // maxValue default 0n
}

type AuthorizeTransaction = (
  session: Session,
  tx: Readonly<TransactionRequest>,
) => boolean | Promise<boolean>;
```

`sponsor: true` asks Privy to sponsor gas; sponsorship must also be enabled for
that chain in the Privy dashboard. `allow.to` is compared case-insensitively.
`allow` does not inspect calldata. A hook allows a transaction only by
returning exactly `true`; any other value, a throw, or a rejection gives
`POLICY_DENIED`. The hook runs after the `allow` list, and `tx.from` and
`tx.to` are checksummed. See
[Transaction rules](integration-guide.md#transaction-rules).

```ts
const chains = {
  8453: { sponsor: true, allow: { to: [GAME_CONTRACT] } },
  1: { sponsor: false, allow: { to: [STAKING], maxValue: 10n ** 17n } },
};
```

### AuthorizeMessage

```ts
interface MessageAuthorizationRequest {
  address: Address; // checksummed
  message: SignableMessage; // string (UTF-8) or { raw: Hex }
}

type AuthorizeMessage = (
  session: Session,
  request: Readonly<MessageAuthorizationRequest>,
) => boolean | Promise<boolean>;
```

Runs before every `signMessage` that is not `trusted`, after the account
check and before Privy is called. Like `AuthorizeTransaction`, only exactly
`true` allows; any other value, a throw, or a rejection gives `POLICY_DENIED`.
See
[Restricting message signing](integration-guide.md#restricting-message-signing).

```ts
// Browsers may not sign at all; the server signs what it builds.
const service = createEmbeddedWalletService({
  ...config,
  authorizeMessage: () => false,
});
await service.signMessage(
  session,
  { address, message: buildLoginMessage(nonce) },
  { trusted: true },
);
```

### AuthorizeExport

```ts
interface ExportAuthorizationRequest {
  address: Address; // checksummed
}

type AuthorizeExport = (
  session: Session,
  request: Readonly<ExportAuthorizationRequest>,
) => boolean | Promise<boolean>;
```

Export is deny-by-default: without this hook every `exportWallet` gives
`POLICY_DENIED`. With it, only exactly `true` allows; any other value, a
throw, or a rejection gives `POLICY_DENIED`. It runs after the account check
and before Privy is called. It should require a fresh step-up, such as a
one-time code emailed to the user, because an exported key escapes every
other rule you have. See
[Exporting the private key](integration-guide.md#exporting-the-private-key).

### WalletStore, WalletRecord, createMemoryWalletStore

```ts
interface WalletRecord {
  userId: string;
  privyUserId: string;
  walletId: string;
  address: Address; // EIP-55 checksummed
  policyIds?: readonly string[]; // persist this; undefined means unknown
}

interface WalletStore {
  get(userId: string): Promise<WalletRecord | null>;
  put(record: WalletRecord): Promise<void>; // must upsert by userId
}

function createMemoryWalletStore(): WalletStore;
```

`createMemoryWalletStore` is for tests and examples only. A complete SQL
implementation is in the
[integration guide](integration-guide.md#the-wallet-store).

### createRequestHandler

```ts
function createRequestHandler(
  service: EmbeddedWalletService,
  options: RequestHandlerOptions,
): RequestHandler;

type RequestHandler = (request: Request) => Promise<Response>;

interface RequestHandlerOptions {
  basePath: string; // starts with '/', no query or fragment
  authenticate: (request: Request) => Promise<Session | null> | Session | null;
  allowedOrigins: readonly string[]; // bare origins, at least one
  logger?: Logger;
}
```

Throws `TypeError` at creation for a `basePath` that does not start with `/` or
contains `?` or `#`, an empty or malformed `allowedOrigins` (entries must be
bare origins such as `https://example.com`), or a non-function `authenticate`.

Order of checks for a request:

1. For any method other than `GET` and `HEAD`: the `Origin` header must be in
   `allowedOrigins` (else 403 `INVALID_REQUEST`); the body is read with a size
   limit (else 413); a non-empty body needs `Content-Type: application/json`,
   optionally with `charset=utf-8` (else 415).
2. `authenticate(request)`. `null` gives 401 `UNAUTHENTICATED`.
3. Route and method (404 `Unknown route.`, 405 with an `Allow` header).
4. Body parse and strict validation, then the service call.

Routes (relative to `basePath`; paths match exactly, no trailing slash):

| Request                 | Body                  | 200 response                             |
| ----------------------- | --------------------- | ---------------------------------------- |
| `GET /wallet`           | none                  | `{ address }`, or 404 `WALLET_NOT_FOUND` |
| `POST /wallet`          | empty or `{}`         | `{ address, created }`                   |
| `POST /sign-message`    | `SignMessageRequest`  | `{ signature }`                          |
| `POST /transactions`    | `TransactionRequest`  | `TransactionResponse`                    |
| `GET /transactions/:id` | none                  | `TransactionResponse`                    |
| `POST /wallet/export`   | `ExportWalletRequest` | `ExportWalletResponse`                   |

Every response is JSON with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Errors use `ErrorResponse`. An error that
is not an `EmbeddedWalletError` returns 500 `PROVIDER_ERROR` with a generic
message and is sent to `logger`. The handler sets no CORS headers and does not
serve `OPTIONS`.

```ts
const handle = createRequestHandler(service, {
  basePath: '/api/wallets/embedded',
  authenticate,
  allowedOrigins: ['https://app.example.com'],
  logger: console,
});
```

### buildWalletPolicy

```ts
function buildWalletPolicy(options: WalletPolicyOptions): WalletPolicy;

interface WalletPolicyOptions {
  contracts: Readonly<Record<number, readonly Address[]>>; // per chain id
  maxValue?: Readonly<Record<number, bigint>>; // wei, keys must be in contracts
  allowPersonalSign: boolean;
  name?: string; // default 'Embedded wallet policy'
}

interface WalletPolicy {
  version: '1.0';
  name: string;
  chain_type: 'ethereum';
  rules: WalletPolicyRule[];
}
```

Returns the body for `privy.policies().create(...)`. One `eth_sendTransaction`
ALLOW rule per chain, with conditions on `chain_id`, `to` (checksummed) and,
when `maxValue` has the chain, `value`. Plus a `personal_sign` ALLOW rule with no
conditions when `allowPersonalSign` is true. Calldata is not constrained.

Throws `TypeError` for: an invalid chain id, a chain with no addresses, an
invalid address, a `maxValue` key without a matching `contracts` key, a
`maxValue` that is not a non-negative bigint, or a policy that would deny
everything (no contracts and `allowPersonalSign: false`).

See [Privy policies](integration-guide.md#privy-policies) for creating it and
passing the id as `policyIds`.

### EmbeddedWalletError

```ts
class EmbeddedWalletError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string);
}
```

The only error service methods throw for request-level failures (invalid
configuration throws `TypeError` at creation instead). `message` is written by
this package and is safe to return to a browser; it never contains Privy or RPC
text, JWTs or signatures.

```ts
try {
  await service.sendTransaction(session, request);
} catch (error) {
  if (error instanceof EmbeddedWalletError && error.code === 'POLICY_DENIED') {
    // show "not allowed"
  }
}
```

### Logger

```ts
interface Logger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
```

`console` satisfies it. Context objects never contain secrets, JWTs or
signatures; upstream text is scrubbed and truncated to 500 characters.

## Client

```ts
import { ... } from '@truflation/privy-embedded-wallet/client';
```

Never imports the server entry, `@privy-io/node` or `@wagmi/core`.

### createEmbeddedWalletClient

```ts
function createEmbeddedWalletClient(
  options: EmbeddedWalletClientOptions,
): EmbeddedWalletClient;

interface EmbeddedWalletClientOptions {
  basePath: string; // where the handler is mounted; trailing slashes are trimmed
  fetch?: typeof fetch; // default: global fetch
  headers?: HeaderValues | (() => HeaderValues | Promise<HeaderValues>);
}

type HeaderValues = Record<string, string | undefined> | Headers | HeadersInit;

interface EmbeddedWalletClient {
  getWallet(): Promise<WalletResponse | null>; // null on 404 WALLET_NOT_FOUND
  ensureWallet(): Promise<WalletResponse>;
  signMessage(request: SignMessageRequest): Promise<SignMessageResponse>;
  sendTransaction(request: TransactionRequest): Promise<TransactionResponse>;
  getTransaction(id: string): Promise<TransactionResponse>;
  exportWallet(request: ExportWalletRequest): Promise<ExportWalletResponse>; // raw; use exportPrivateKey
}
```

Every request sends cookies (`credentials: 'include'`), `Accept:
application/json`, and for POST `Content-Type: application/json`. A `headers`
callback runs before each request. Header entries whose value is `undefined` are
dropped.

Errors: every failure throws [`EmbeddedWalletClientError`](#client-errors). A
network failure has `code` `PROVIDER_ERROR` and `status` 0. A non-2xx response
carries the server's `code`; a body that is not a valid error body becomes
`PROVIDER_ERROR` with the HTTP status. A 2xx body of the wrong shape is
`PROVIDER_ERROR` too. `getTransaction` URL-encodes the id.

`sendTransaction` takes a full `TransactionRequest`, so you generate the
`requestId` (`crypto.randomUUID()`), and you must reuse it if you retry the
same intent.

```ts
const client = createEmbeddedWalletClient({
  basePath: '/api/wallets/embedded',
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
});
const wallet = await client.ensureWallet();
```

### exportPrivateKey

```ts
function exportPrivateKey(
  client: Pick<EmbeddedWalletClient, 'exportWallet'>,
  options: ExportPrivateKeyOptions,
): Promise<Hex>;

interface ExportPrivateKeyOptions {
  address: Address; // the wallet the page believes it exports
}
```

Resolves with the wallet's private key as `0x`-prefixed lowercase hex,
decrypted in the page. It generates a one-time P-256 ECDH key pair with
WebCrypto (private half non-extractable), sends only the public half to
`POST /wallet/export`, and opens Privy's answer locally with HPKE base mode:
DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, empty `info` and
`aad`, the suite `@privy-io/node` uses for its own export. It then checks the
key controls `address`, so a host cannot hand the user a key it knows.

Server refusals throw `EmbeddedWalletClientError` with the server's code
(`POLICY_DENIED` when the host has not enabled export or its step-up failed).
A response that cannot be decrypted, is not a 32-byte hex key, or does not
match `address` throws `PROVIDER_ERROR` with `status` 0. Needs a secure
context (`crypto.subtle`). The HPKE code (`@hpke/core`,
`@hpke/chacha20poly1305`, about 40 KB minified, 11 KB gzipped) is loaded with
a dynamic `import()` on first call, so pages that never export do not load
it.

It is not reachable through the EIP-1193 provider or the wagmi connector: it
is always an explicit host call. See
[Exporting the private key](integration-guide.md#exporting-the-private-key)
for how to show the result.

### createEmbeddedProvider

The EIP-1193 provider the connector uses. You rarely call it directly.

```ts
function createEmbeddedProvider(
  options: CreateEmbeddedProviderOptions,
): EmbeddedProvider;

interface CreateEmbeddedProviderOptions {
  client: EmbeddedWalletClient;
  chainIds: readonly [number, ...number[]];
  initialChainId?: number; // default: first of chainIds
  pollingInterval?: number; // default 1000 ms, backs off by 1.5x to 5000 ms
  transactionTimeout?: number; // default 120000 ms
  onChainChanged?: (chainId: number) => void | Promise<void>;
}

interface EmbeddedProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
  readonly chainId: number;
  setChainId(chainId: number): void; // no event, ignores unknown chains
  reset(): void; // drop the cached address
}
```

Methods and error codes are described in the
[behaviour reference](integration-guide.md#behaviour-reference). Events emitted:
`accountsChanged` with `[]` when the account is lost (after `ACCOUNT_MISMATCH`,
`UNAUTHENTICATED` or `REAUTH_REQUIRED`), and `chainChanged` with a hex string.
Anything thrown from `request` is an `EmbeddedProviderError`.

### Client errors

```ts
class EmbeddedWalletClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number; // HTTP status, 0 when no response was received
}

class LoginRequiredError extends Error {
  readonly code: 'UNAUTHENTICATED';
}

class EmbeddedProviderError extends Error {
  readonly code: number; // EIP-1193 or JSON-RPC code
  readonly data?: unknown; // { code, requestId?, id?, hash? }
}

const RPC_ERROR_CODE = {
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN: 4902,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TRANSACTION_FAILED: -32000,
  RESOURCE_NOT_FOUND: -32001,
  TRANSACTION_REJECTED: -32003,
} as const;
```

- `EmbeddedWalletClientError` comes from `EmbeddedWalletClient` calls.
- `LoginRequiredError` (also exported from `/wagmi`) comes from the connector's `connect()` for a signed-out
  visitor.
- `EmbeddedProviderError` is what the provider throws, so it is what wagmi
  surfaces for `signMessage` and `sendTransaction`. `data.code` holds the
  protocol code when the cause was a server error. For send failures `data`
  includes `requestId`, and on a timeout or failed transaction also the
  transaction `id` and, when known, `hash`.

```ts
try {
  await sendTransaction(config, { to, value: 0n });
} catch (error) {
  if (
    error instanceof EmbeddedProviderError &&
    error.code === RPC_ERROR_CODE.TRANSACTION_REJECTED
  ) {
    // POLICY_DENIED
  }
}
```

wagmi may wrap errors on the way out (for example in its own error classes), so
walk `error.cause` if an `instanceof` check does not match.

## Wagmi

```ts
import { ... } from '@truflation/privy-embedded-wallet/wagmi';
```

The wagmi connector. Needs `@wagmi/core` (3.3.0 or later, below 4) as a peer
dependency; no other entry imports it. Also re-exports `LoginRequiredError`
(the same class `/client` exports), since connector users catch it.

### embeddedWallet

```ts
function embeddedWallet(options: EmbeddedWalletOptions): CreateConnectorFn;

interface EmbeddedWalletOptions {
  client: EmbeddedWalletClient;
  hasSession: () => boolean | Promise<boolean>;
  onLoginRequired?: () => void;
  id?: string; // default 'embedded-wallet'
  name?: string; // default 'Your account'
  icon?: string;
  pollingInterval?: number; // ms, default 1000
  transactionTimeout?: number; // ms, default 120000
}
```

Returns a wagmi connector creator (`type` is `'embeddedWallet'`). Pass the result
in wagmi's `createConfig({ connectors })` or in `WagmiAdapter({ connectors })`.
Its chains come from the wagmi config, in order; the first is the default.

Connector behaviour:

| Method                 | Behaviour                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup()`              | Loads the persisted chain id from `config.storage` (key `<id>.chainId`).                                                                                                                                             |
| `connect(params)`      | If `hasSession()` is false: calls `onLoginRequired` (not while `isReconnecting`) and throws `LoginRequiredError`. Otherwise `ensureWallet`, applies `params.chainId` if configured, returns `{ accounts, chainId }`. |
| `disconnect()`         | Drops connector state only. Never ends the site session.                                                                                                                                                             |
| `getAccounts()`        | `[]` when signed out, else the wallet address (checksummed).                                                                                                                                                         |
| `getChainId()`         | The current chain id.                                                                                                                                                                                                |
| `getProvider()`        | The [`EmbeddedProvider`](#createembeddedprovider).                                                                                                                                                                   |
| `isAuthorized()`       | True when `hasSession()` is true and a wallet exists. False on any error.                                                                                                                                            |
| `switchChain()`        | Switches the provider chain, persists it, and emits wagmi's `change` event.                                                                                                                                          |
| `notifySessionEnded()` | Extra property. Drops cached state and emits wagmi's `disconnect`. Call it when the site session ends.                                                                                                               |

```ts
const connector = embeddedWallet({
  client,
  hasSession: async () => (await getToken()) !== null,
  onLoginRequired: () => openLoginDialog(),
});
```

### getEmbeddedWalletConnector

```ts
function getEmbeddedWalletConnector(
  config: Pick<Config, 'connectors'>,
  id?: string, // default 'embedded-wallet'
): (Connector & EmbeddedWalletConnectorProperties) | undefined;

interface EmbeddedWalletConnectorProperties extends Record<string, unknown> {
  notifySessionEnded(): void;
}
```

Finds the registered connector by `id` and type, typed with
`notifySessionEnded`. Returns `undefined` if there is none. Pass the same `id`
you gave `embeddedWallet`.

```ts
getEmbeddedWalletConnector(config)?.notifySessionEnded();
```

## Vue

```ts
import { useEmbeddedWallet } from '@truflation/privy-embedded-wallet/vue';
```

Needs Vue 3.4 or later as a peer dependency.

```ts
function useEmbeddedWallet(client: EmbeddedWalletSource): UseEmbeddedWallet;

interface EmbeddedWalletSource {
  getWallet(): Promise<WalletResponse | null>;
  ensureWallet(): Promise<WalletResponse>;
}

type EmbeddedWalletStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

interface UseEmbeddedWallet {
  address: Ref<Address | null>;
  status: Ref<EmbeddedWalletStatus>;
  error: Ref<Error | null>;
  refresh(): Promise<void>; // look up, do not create
  ensure(): Promise<void>; // find or create
}
```

The result of `createEmbeddedWalletClient` satisfies `EmbeddedWalletSource`.
The composable does nothing until `refresh()` or `ensure()` is called. Both set
`status` to `loading`, then `ready` (with `address`), `missing` (`refresh` found
no wallet) or `error` (with `error`, and `address` cleared). Only the latest
call writes state. The functions never reject; read `status` and `error`.

```ts
const wallet = useEmbeddedWallet(walletClient);
await wallet.refresh();
if (wallet.status.value === 'missing') await wallet.ensure();
```
