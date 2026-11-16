# Design

This document is the contract the three entry points are built against.
Change it before changing the code.

## What this package does

A site that already has its own accounts (for example Supabase Auth) gives
each account a Privy embedded wallet, without Privy's React SDK:

1. The user signs in to the site as usual, by any method the site offers.
2. The site's server passes the user's session JWT to Privy, which verifies
   it against the site's public keys (Privy "custom auth").
3. Privy holds the wallet key. The site's server asks Privy to sign, proving
   the user's consent with that same JWT on every request.
4. In the browser the wallet appears as a normal wagmi connector, so existing
   wagmi code (reads, `signMessage`, `sendTransaction`) works unchanged.

The package never handles login. It takes a JWT and returns a wallet.

```
browser                       host server                      Privy
-------                       -----------                      -----
wagmi connector  --HTTP-->  request handler  --@privy-io/node-->  wallet API
(/wagmi)                    (/server)
```

## Entry points

| Entry     | Runs in | Contains                                               |
| --------- | ------- | ------------------------------------------------------ |
| `/server` | Node    | Wallet service, request handler, policy builder, store |
| `/client` | Browser | HTTP client, EIP-1193 provider, key export helper      |
| `/wagmi`  | Browser | wagmi connector                                        |
| `/vue`    | Browser | Headless composables, unstyled components              |

`src/protocol` holds the wire types and route paths both sides share. It is
re-exported from `/server` and `/client`. `/client` and `/vue` must never
import `/server` or `@privy-io/node`. `/client` must never import `@wagmi/core`
or `/wagmi`; only `/wagmi` may, so the HTTP client and provider load without
wagmi installed.

## Server

### Service

```ts
const service = createEmbeddedWalletService({
  appId, // Privy app id
  appSecret, // Privy app secret. Server only.
  store, // WalletStore, see below
  chains: {
    1: { sponsor: true, allow: { to: [DEPOSIT_CONTRACT, USDC] } },
    560048: { sponsor: false },
  },
  authorizeTransaction, // optional (session, tx) => boolean
  authorizeMessage, // optional (session, { address, message }) => boolean
  authorizeExport, // required to enable export: (session, { address }) => boolean
  policyIds, // optional Privy policy ids attached to new wallets
  logger, // optional
});
```

Every method takes a `Session`: `{ userId, jwt }`. `userId` is the subject the
host already verified. `jwt` is the raw session token, forwarded to Privy as
the user's authorization. The service never trusts a user id from a request
body.

| Method                                    | Result                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `getWallet(session)`                      | `{ address }` or `null`. Reads the store only.                                                                               |
| `ensureWallet(session)`                   | `{ address, created }`. Finds or creates the Privy user and a user-owned wallet. Idempotent and safe under concurrent calls. |
| `signMessage(session, request, options?)` | `{ signature }` using `personal_sign`. `options.trusted` skips `authorizeMessage` (rule 11).                                 |
| `sendTransaction(session, request)`       | `{ id, status, hash? }`. Sponsored when the chain config says so.                                                            |
| `getTransaction(session, id)`             | `{ id, status, hash? }`. Rejects ids that do not belong to the session's wallet.                                             |
| `exportWallet(session, request)`          | `{ ciphertext, encapsulatedKey }`: the private key, HPKE-encrypted by Privy to the browser's key (rule 12).                  |

Rules:

- Sponsored sends can return before a hash exists. `sendTransaction` returns
  what it has. `getTransaction` is the polling path.
- A chain missing from `chains` is rejected with `CHAIN_NOT_SUPPORTED`.
- Typed-data signing is out of scope until a consumer needs it.
- Failures are thrown as `EmbeddedWalletError` with a `code` from
  `ERROR_CODE` in the protocol. A JWT that Privy rejects maps to
  `REAUTH_REQUIRED`. Privy and RPC error details go to the optional `logger`
  and are never returned to the client.

### Store

The host owns persistence. The package defines the interface and ships an
in-memory implementation for tests and examples.

```ts
interface WalletRecord {
  userId: string;
  privyUserId: string;
  walletId: string;
  address: Address;
  /** Policies the wallet really has in Privy. Hosts must persist this. */
  policyIds?: readonly string[];
}
interface WalletStore {
  get(userId: string): Promise<WalletRecord | null>;
  /** Must be an upsert keyed by userId. */
  put(record: WalletRecord): Promise<void>;
}
```

The store is a cache of what Privy already knows. If a record is missing,
`ensureWallet` recovers it from Privy before creating anything.

### Request handler

```ts
const handle = createRequestHandler(service, {
  basePath: '/api/wallets/embedded',
  authenticate: async (request) => session, // { userId, jwt } or null
  allowedOrigins: ['https://example.com'],
});
// handle: (request: Request) => Promise<Response>
```

One Web-standard `Request -> Response` function serves every route in
`ROUTES`, so any framework can mount it in a few lines. It:

- rejects state-changing requests whose `Origin` is not allowed, and bodies
  that are not `application/json`, before it calls `authenticate`;
- then calls `authenticate` and returns 401 `UNAUTHENTICATED` on `null`;
- validates every body strictly (unknown fields rejected, addresses and hex
  checked, sizes bounded);
- maps `EmbeddedWalletError` codes to HTTP statuses and the `ErrorResponse`
  body;
- sets `Cache-Control: no-store`.

Rate limiting is the host's job and is documented as such.

### Policy

`buildWalletPolicy({ contracts: { [chainId]: Address[] }, maxValue?, allowPersonalSign, name? })`
returns the Privy policy body. Privy policies deny by default, so the builder
always emits an explicit rule for `personal_sign` when it is allowed.

## Client

```ts
const client = createEmbeddedWalletClient({
  basePath: '/api/wallets/embedded',
});
const connector = embeddedWallet({
  client,
  hasSession: () => true, // boolean or Promise<boolean>
  onLoginRequired: () => {},
  id: 'embedded-wallet',
  name: 'Your account',
  icon,
});
```

- `createEmbeddedWalletClient` is a thin typed `fetch` wrapper over the
  protocol. It sends cookies by default and accepts a `headers` callback for
  hosts that use bearer tokens. Non-2xx responses throw
  `EmbeddedWalletClientError` carrying the protocol `code`.
- `createEmbeddedProvider` is the EIP-1193 provider. It supports
  `eth_accounts`, `eth_requestAccounts`, `eth_chainId`, `personal_sign`,
  `eth_sendTransaction` and `wallet_switchEthereumChain`. Everything else
  fails with EIP-1193 code 4200. `eth_sendTransaction` submits, then polls
  until a hash exists, and resolves with the hash.
- `embeddedWallet` is the wagmi connector.
- `exportPrivateKey(client, { address })` exports the private key (see
  [Export](#export)). It is a separate host call, never reachable through the
  provider or the connector.

Connector behaviour, confirmed by a browser spike against Reown AppKit
1.8.17 with `@wagmi/core` 3.3.2:

- Passing the connector in `WagmiAdapter`'s `connectors` option registers it.
  Calling wagmi `connect()` on it connects without opening the AppKit modal,
  and AppKit's own state (address, connected flag, network) follows shortly
  after.
- `signMessage` and `switchChain` through wagmi reach the connector, and
  AppKit follows chain changes.
- After a page reload the connection is restored automatically when
  `isAuthorized()` returns true. The connector must persist its chain id
  (through `config.storage`), otherwise the chain resets to the first one.
- AppKit lists the connector in its connect modal under the connector's
  `name`. So `connect()` must behave sensibly for a signed-out visitor: it
  throws `LoginRequiredError` and calls the optional `onLoginRequired`
  callback so the host can open its login screen. The callback is skipped
  when wagmi is reconnecting on page load, so a reload never opens it.
- AppKit's disconnect calls the connector's `disconnect()`. That only
  deactivates the wallet. It must never sign the user out of the host site.

`isAuthorized()` is true when `hasSession()` is true and the wallet exists.
`connect()` calls the client's `ensureWallet`.

## Export

A user can export the wallet's private key to import it elsewhere. The host
server must never be able to read the key, so the browser, not the server,
is the HPKE recipient:

1. `exportPrivateKey` generates a P-256 ECDH key pair with WebCrypto, private
   half non-extractable, and posts the base64 SPKI public key with the
   expected `address` to `POST /wallet/export`.
2. The service runs the usual checks, then `authorizeExport`, exchanges the
   JWT, and calls Privy's export endpoint with `encryption_type: 'HPKE'` and
   that key as `recipient_public_key`, authorized by the user's JWT. It
   returns Privy's `ciphertext` and `encapsulated_key` unchanged.
3. The browser opens them with HPKE and checks the key controls `address`.

The suite and formats are those `@privy-io/node` 0.39.0 uses for its own
export (`setupHPKERecipient` in `lib/cryptography.js`, `export` in
`public-api/services/wallets.js`): HPKE base mode, DHKEM(P-256, HKDF-SHA256),
HKDF-SHA256, ChaCha20-Poly1305, empty `info` and `aad`; the recipient key as
base64 DER SPKI; ciphertext and encapsulated key as base64; the plaintext the
key as UTF-8 text. The SDK's own `exportPrivateKey` is not used because it
generates the recipient key and decrypts on the caller, which here is the
host server. The gateway builds the same signed request around the browser's
key instead.

The browser needs ChaCha20-Poly1305, which WebCrypto lacks, so `/client`
depends on `@hpke/core` and `@hpke/chacha20poly1305`, the implementation the
Privy SDK itself uses, loaded by dynamic `import()` on first export.

This is unit-tested against the SDK's own HPKE code, and it has been run end
to end against a Privy development app with a user-owned wallet authorized by
a user JWT. Integrators should still verify it against their own Privy app.

## Vue

- `useEmbeddedWallet(client)`: `{ address, status, error, refresh(), ensure() }`.

Composables hold no styling and no host-specific routes.

## Hardening rules

These came out of the first security review and are part of the contract.

1. **Sends are idempotent per intent.** The client creates a `requestId`
   (UUID) once per `eth_sendTransaction` call and reuses it on every retry.
   The server derives Privy's idempotency key from the user id and the
   `requestId`, and passes it as the transaction's `reference_id`. Repeating a
   request with the same `requestId` returns the original transaction. The
   provider may therefore retry an ambiguous failure (network error, 5xx,
   timeout) with the same `requestId`, and only then report failure.
2. **Every sign and send names the account.** Requests carry the address the
   client expects (`address` on sign, `from` on send). The server rejects a
   mismatch with `ACCOUNT_MISMATCH`. On that code, and on `UNAUTHENTICATED`
   or `REAUTH_REQUIRED`, the provider clears its cached address and emits
   `accountsChanged`, so a different user signing in can never see or act
   under the previous user's address.
3. **Transactions are authorized on the server.** Chain config is
   `{ sponsor, allow? }` where `allow` is
   `{ to: Address[], maxValue?: bigint }` (`maxValue` defaults to `0n`). The
   service also accepts an `authorizeTransaction(session, tx)` hook returning
   a boolean. A transaction must pass the chain's `allow` list if present and
   the hook if present, otherwise it is rejected with `POLICY_DENIED` before
   Privy is called. Creating the service throws if a chain has
   `sponsor: true` and has neither an `allow` list nor a hook, because that
   would let any account spend the app's gas budget on anything.
4. **The session must match its token.** The service decodes the JWT and
   requires its user id claim (`userIdClaim`, default `sub`) to equal
   `session.userId`. The signature is not re-verified here: that is the
   host's job in `authenticate`, and Privy verifies it again.
5. **Recovered wallets carry the configured policy.** When `policyIds` is
   set and a wallet found in Privy lacks it, the service attaches it, or
   refuses to sign and send for that wallet if it cannot.
6. **The handler checks origin and content type before `authenticate`** for
   every state-changing request. The content type is only checked when the
   request has a body.
7. **Only a rejected token means re-login.** `REAUTH_REQUIRED` is returned
   only when Privy answers 401 to the token exchange or the request. Other
   failures are `PROVIDER_ERROR`.
8. **Uncertain is pending, not failed.** Privy statuses that can still end in
   a mined transaction (`replaced`, `provider_error`) map to `pending`. A
   failed transaction is reported with its hash when one exists.
9. **The provider refuses what it cannot honour.** `eth_sendTransaction`
   treats `input` as an alias of `data`, ignores gas and fee fields (Privy
   sets them), and rejects `nonce`, `accessList`, `authorizationList` and
   blob fields with code -32602 instead of silently dropping them.
10. **The SDK cannot leak.** The Privy client is created with logging off
    and an explicit API URL, so environment variables cannot turn on request
    logging or redirect traffic.
11. **Message signing can be authorized on the server.** The service accepts
    an `authorizeMessage(session, { address, message })` hook, run after the
    session and account checks and before Privy is called. It behaves like
    `authorizeTransaction`: only `true` allows, and anything else, a throw or
    a rejection is `POLICY_DENIED`. Passing `{ trusted: true }` as the third
    argument of `signMessage` skips the hook. It exists for messages the
    host's own server code built, and must never be derived from request
    input. The request handler never passes it, so every browser request is
    gated.
12. **Export is deny-by-default.** `exportWallet` is refused with
    `POLICY_DENIED` unless the service has an `authorizeExport(session,
{ address })` hook, which behaves like `authorizeMessage` (only `true`
    allows; anything else, a throw or a rejection denies). The hook should
    require a fresh step-up such as an emailed code, not just a session,
    because an exported key can no longer be limited by any host rule or
    Privy policy, and cannot be revoked. The policy check of rule 5 is not
    applied: it governs signing, which the exported key is beyond.
    `recipientPublicKey` must decode to exactly a P-256 SPKI. The ciphertext
    passes through the host unread and is never logged; only its shape is
    checked. Each export is logged at `warn` with the wallet id.

Known limits, documented for integrators rather than solved here: signing
needs no per-action confirmation, so any script running on the site can sign
and send within the server's rules (rules 3 and 11 and the Privy policy are
the real limits); without an `authorizeMessage` hook, any message is signed
for a signed-in user; the policy builder constrains chain, recipient and value, not
calldata; Privy keeps an exchanged signing key until it expires, so
revoking a session early depends on the host's `authenticate`; and once a key
is exported, nothing here can limit or revoke it.

## Security invariants

1. The Privy app secret and `@privy-io/node` exist only in `/server`.
2. The user id always comes from the host's verified session.
3. A user can only read or act on their own wallet and transactions.
4. Nothing from Privy's or the RPC's error output reaches the browser.
5. No secret, JWT or signature is ever logged.
6. The host server never holds anything that decrypts an exported key.

## Testing

- Unit tests mock Privy and `fetch`. They run with no credentials.
- Integration tests under `test/integration` run only when `PRIVY_APP_ID`,
  `PRIVY_APP_SECRET` and `TEST_USER_JWT` are set, against a Privy development
  app. See `docs/local-development.md`.
