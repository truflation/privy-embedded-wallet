# @truflation/privy-embedded-wallet

Privy embedded wallets for sites that already have their own accounts, without
Privy's React SDK. Your server keeps issuing its own session JWTs (for example
from Supabase Auth). This package gives each account a wallet that appears in
the browser as a normal wagmi connector, and signs on the server through
`@privy-io/node`.

It is for engineers on Vue, Nuxt or any non-React site who want embedded
wallets tied to their existing login. It does not handle login, ship styled UI,
provide a fiat onramp, or sign typed data. It is not a hosted service: you run
the server side, bring your own database, and need your own Privy app.

Start with the [integration guide](docs/integration-guide.md).

## Why this exists

Privy's main web SDK, with its login and wallet screens, is a React library.
A site built on Vue, Nuxt, Svelte, or plain server-rendered pages cannot drop
it in, and a site that already has its own login does not want a second login
system beside the first.

Privy also offers a server-side route that needs no React: custom
authentication, where Privy verifies the JWTs your own auth already issues,
and server wallets, where your server asks Privy to sign for a user and proves
the user's consent with that same JWT. The pieces exist, but wiring them into
a safe, usable wallet is real work: provisioning and recovery, idempotent
sends, account checks, limits on what may be signed, a browser provider, a
wagmi connector that cooperates with wallet modals, and key export that keeps
the key away from your server.

This package is that wiring. It was built for
[Truflation](https://truflation.com), a Nuxt site with Supabase Auth and Reown
AppKit, and is kept in its own repository so it can be updated on its own
schedule and used by other sites with a similar shape:

- your front end is not React, or you do not want Privy's UI;
- you already have accounts and sessions, and can issue asymmetric JWTs;
- you want users to get a wallet without installing anything, alongside any
  external wallets you already support through wagmi.

If your site is React and you are happy with Privy's own login, use Privy's
React SDK instead. It does more with less code.

## Install

The package is distributed as a tarball attached to each
[GitHub Release](https://github.com/truflation/privy-embedded-wallet/releases),
not through the npm registry:

```sh
npm install https://github.com/truflation/privy-embedded-wallet/releases/download/v0.1.0/truflation-privy-embedded-wallet-0.1.0.tgz
```

## Entry points

- `@truflation/privy-embedded-wallet/server`: Node. Wallet service, request
  handler, policy builder, store interface.
- `@truflation/privy-embedded-wallet/client`: Browser. HTTP client, EIP-1193
  provider, key export helper.
- `@truflation/privy-embedded-wallet/wagmi`: Browser. wagmi connector. The only
  entry that needs the optional `@wagmi/core` peer.
- `@truflation/privy-embedded-wallet/vue`: Headless Vue 3 composable.

## Quick start

Server (any Fetch-style runtime; Nitro, Hono and Node examples are in the
guide):

```ts
import {
  createEmbeddedWalletService,
  createRequestHandler,
} from '@truflation/privy-embedded-wallet/server';

const service = createEmbeddedWalletService({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!, // server only
  store, // your WalletStore (database backed)
  chains: {
    11155111: { sponsor: false, allow: { to: [CONTRACT] } },
  },
});

export const handle = createRequestHandler(service, {
  basePath: '/api/wallets/embedded',
  allowedOrigins: ['https://app.example.com'],
  // Verify your JWT here; return { userId, jwt } or null.
  authenticate: async (request) => verifyMySession(request),
});
// Mount `handle(request: Request): Promise<Response>` at the base path.
```

Client:

```ts
import { createConfig, http } from '@wagmi/core';
import { sepolia } from '@wagmi/core/chains';
import { createEmbeddedWalletClient } from '@truflation/privy-embedded-wallet/client';
import { embeddedWallet } from '@truflation/privy-embedded-wallet/wagmi';

const client = createEmbeddedWalletClient({
  basePath: '/api/wallets/embedded',
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
});

export const config = createConfig({
  chains: [sepolia],
  transports: { [sepolia.id]: http() },
  connectors: [
    embeddedWallet({
      client,
      hasSession: async () => (await getToken()) !== null,
      onLoginRequired: () => openLoginDialog(),
    }),
  ],
});
// connect(config, { connector }), signMessage and sendTransaction now work,
// where connector comes from getEmbeddedWalletConnector(config).
```

You also need a Privy app with custom auth pointed at your JWT keys. That setup,
the wallet store, transaction rules, Privy policies, sign-out wiring and a
production checklist are in the guide.

## Documentation

- [Integration guide](docs/integration-guide.md): start here. Setup, server and
  client integration, behaviour, security model, troubleshooting.
- [API reference](docs/api.md): every export with signatures and errors.
- [Local development](docs/local-development.md): test against real services
  with a Privy development app and a local Supabase stack.
- [Design](docs/design.md): the contract and hardening rules the code follows.
- [Example app](examples/supabase-appkit): Supabase Auth and Reown AppKit.

## Status and versioning

Pre-1.0 and under active development. The API may change between minor
versions, so pin the version you use and review the changes before upgrading.
The code has not been independently audited. Key export has been run end to
end against a Privy development app, but only for one wallet configuration, so
test it against your own app. Review the package against your own threat model
before holding real funds.
The server entry requires Node 22 or later. The wagmi entry requires
`@wagmi/core` 3.3.0 or later (below 4).

## License

MIT. See [LICENSE](LICENSE).
