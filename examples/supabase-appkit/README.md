# Supabase and AppKit example

A small app that shows the full integration of
`@truflation/privy-embedded-wallet`: Supabase Auth provides the accounts,
Reown AppKit provides the wallet UI, and the package gives each account a Privy
embedded wallet. It also works as an end-to-end test harness. The page exposes
buttons with stable `data-testid` values, a `state` panel, and
`window.__demo.state()` / `window.__demo.actions` for automated tests.

- `server.ts`: a plain Node `http` server on `127.0.0.1:8787` that mounts the
  package's request handler at `/api/wallets/embedded`. It verifies the
  Supabase access token with `jose` against the project's JWKS.
- `index.html` and `src/main.ts`: a vanilla TypeScript page served by Vite on
  port 5173, which proxies `/api` to the server.

Configured chains: Sepolia (`11155111`, sponsored) and Hoodi (`560048`, not
sponsored).

## Prerequisites

- A Supabase project that signs JWTs with an asymmetric key. The server checks
  tokens against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, which only
  lists asymmetric public keys. A project that still uses the legacy shared
  secret will not work.
- A Privy app with custom JWT auth configured to trust the Supabase project's
  signing keys (issuer `${SUPABASE_URL}/auth/v1`).
- Gas sponsorship enabled for Sepolia in the Privy dashboard, if `sponsor: true`
  is kept for that chain.
- A Reown project id.

## Run

From the repository root, build the package first, because the example
consumes `dist/` through a `file:` dependency:

```sh
npm install
npm run build
```

Then in this folder:

```sh
cp .env.example .env   # fill in the values
npm install
npm run server         # terminal 1
npm run dev            # terminal 2, then open http://localhost:5173
```

`npm run server` does not load `.env` by itself. Either export the server
variables (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `SUPABASE_URL`, optionally
`APP_ORIGIN`) in the shell, or run `npx tsx --env-file=.env server.ts`. Vite
reads the `VITE_` variables from `.env` on its own. The server exits with the
names of any missing variables.

`npm run typecheck` checks the example, and `npm run build` makes a production
bundle.

## Transaction rules

A sponsored chain must have an `allow` list or an `authorizeTransaction` hook,
otherwise any account could spend the app's gas budget on anything. `server.ts`
uses a hook that permits only an empty, zero-value transaction from the wallet
to itself, which is what the page's send button submits. Anything else is
refused with `POLICY_DENIED`. A real site would give each chain an `allow` list
of its own contracts, or a hook that applies its own limits.

## What the example leaves out

It keeps wallets in `createMemoryWalletStore()`, which loses them on restart,
and it sets no `authorizeMessage` or `authorizeExport`, so the server signs
any message a signed-in user sends and refuses every key export. A real site
needs a database-backed store and should set both hooks; see the
[integration guide](../../docs/integration-guide.md#transaction-rules).

## Notes

- `package.json` overrides `wagmi` and `@wagmi/connectors` so that AppKit's
  wagmi adapter works with `@wagmi/core` 3.3.2. Without it the build fails on a
  missing `@wagmi/core/tempo` export.
- `vite.config.ts` and `tsconfig.json` pin `@wagmi/core` and `viem` to the
  example's copies, because the linked package has its own `node_modules`.
