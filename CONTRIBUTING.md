# Contributing

## Setup

Use Node 24 (see `.nvmrc`), then install dependencies from the lockfile:

```sh
nvm use
npm ci
```

## Checks

```sh
npm test          # run the test suite once (vitest)
npm run lint      # ESLint and Prettier checks
npm run typecheck # tsc --noEmit
npm run build     # bundle the server, client, and vue entry points with tsup
npm run format    # apply Prettier formatting
```

Run all of them before opening a pull request. CI runs the same commands on Node 24.

## Layout rules

- `src/server` is the only place that may import `@privy-io/node`.
- `src/client` and `src/vue` must not import `@privy-io/node` or anything from `src/server`. ESLint enforces this.
- `src/client` and `src/vue` must not import `@wagmi/core`; only `src/wagmi` may. ESLint and the build check (`scripts/check-dist.mjs`) enforce this.
- Do not commit `.env` files or key material. Copy `.env.example` for local configuration.
