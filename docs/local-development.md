# Local development

How to develop and test this package, and an integration of it, against real
services without touching production. You need:

- a **Privy development app**, separate from any production app;
- a **local Supabase stack** (or any auth system you can run locally) that signs
  tokens with an asymmetric key;
- a testnet and a little testnet currency.

Contents:

1. [Unit tests](#unit-tests)
2. [A Privy development app](#a-privy-development-app)
3. [A local Supabase stack with an asymmetric key](#a-local-supabase-stack-with-an-asymmetric-key)
4. [Trusting the local key in Privy](#trusting-the-local-key-in-privy)
5. [Getting a test user token](#getting-a-test-user-token)
6. [Integration tests against Privy](#integration-tests-against-privy)
7. [Running the example](#running-the-example)
8. [Funding a test wallet](#funding-a-test-wallet)

Never commit key files, certificates' private keys, `.env` files or tokens. The
repository's `.gitignore` already excludes `.env*`, `*.pem` and
`signing_keys*.json`, but keep working copies of keys outside the repository
anyway.

## Unit tests

Unit tests need no credentials. They mock Privy and `fetch`.

```sh
nvm use          # Node 24, see .nvmrc (the package supports Node 22 or later)
npm ci
npm test         # vitest run
npm run typecheck
npm run lint     # ESLint and Prettier checks
npm run build    # tsup: server, client, wagmi and vue bundles into dist/
```

The integration tests under `test/integration` are skipped unless the
environment variables below are set, so `npm test` is safe to run anywhere.

## A Privy development app

Create a second app in the Privy dashboard for development and configure it as
in [Privy dashboard setup](integration-guide.md#privy-dashboard-setup), with
these differences:

- Use its own app id and app secret. Never reuse production credentials.
- Enable fee sponsorship for the testnets you want to sponsor. Not every chain
  is offered (Hoodi testnet is not), so keep at least one unsponsored testnet
  in your test matrix.
- The JWT verification settings point at your local auth stack, as described
  below.

## A local Supabase stack with an asymmetric key

A local Supabase project may sign tokens with a shared secret unless you
configure a signing key. Privy needs an asymmetric key. This uses the Supabase CLI; check its current
documentation if a command differs.

1. Initialize and generate a signing key:

   ```sh
   supabase init                                   # once per project
   supabase gen signing-key --algorithm RS256
   ```

2. Tell the stack where the key file is. In `supabase/config.toml`, under
   `[auth]`:

   ```toml
   [auth]
   signing_keys_path = "./signing_keys.json"
   ```

   Once that path is set, `supabase gen signing-key` writes the key into the
   file instead of printing it. If the file did not exist when you first ran the
   command, run it again after setting the path.

3. Start (or restart) the stack:

   ```sh
   supabase stop     # if it was running
   supabase start
   ```

   The local JWKS is then normally at
   `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`. Open it in a browser:
   it must list your RS256 public key.

The signing key file is a secret. The script below expects private RSA JWKs,
either a JSON array of them or a single object. It was tested with a generated
key in that shape. The Supabase CLI itself was not available when this was
written, so its exact file layout was not checked; if yours differs, adjust the
script's lookup.

RS256 matters: Privy's certificate option (next section) accepts only an RS256
key. Do not use `ES256` for the local key.

## Trusting the local key in Privy

Privy calls your JWKS URL from its own servers, and it cannot reach `localhost`.
For local work, use the **Public verification certificate** option instead of
the JWKS endpoint:

- It accepts only an **X.509 certificate** with an **RS256** key. A bare public
  key (PEM or JWK) is rejected.
- So wrap the stack's RS256 public key in a self-signed certificate.

You need Node 22 or later and `openssl` (tested with OpenSSL 3.5).

### Step 1: convert the private JWK to PEM

Save this as `jwk-to-pem.mjs` (outside your repository, for example in
`~/local-auth`):

```js
import { createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, kid] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    'usage: node jwk-to-pem.mjs <signing_keys.json> <out.pem> [kid]',
  );
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(input, 'utf8'));
const keys = Array.isArray(parsed) ? parsed : [parsed];
const jwk = kid
  ? keys.find((key) => key.kid === kid)
  : keys.find((key) => key.kty === 'RSA' && key.d);
if (!jwk) {
  console.error('No matching RSA private key found.');
  process.exit(1);
}

const pem = createPrivateKey({ key: jwk, format: 'jwk' }).export({
  type: 'pkcs8',
  format: 'pem',
});
writeFileSync(output, pem, { mode: 0o600 });
console.log(`Wrote ${output} for key ${jwk.kid ?? '(no kid)'}`);
```

Run it with the path to your stack's key file:

```sh
node jwk-to-pem.mjs path/to/signing_keys.json local-jwt-key.pem
```

If the file holds several RSA keys, pass the `kid` of the one that signs your
tokens as a third argument (see [Getting a test user token](#getting-a-test-user-token)
for how to read a token's `kid`). The output file is created readable by you
only.

### Step 2: make a self-signed certificate

```sh
openssl req -new -x509 -key local-jwt-key.pem -sha256 -days 3650 \
  -subj "/CN=local-dev-jwt" -out local-jwt-cert.pem
```

`local-jwt-cert.pem` holds only public information. Paste its full contents,
including the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----`
lines, into the Privy dev app's JWT integration, under **Public verification
certificate**. Delete `local-jwt-key.pem` when you no longer need it, or keep it
somewhere private.

### Step 3: set the other Privy JWT fields

In the Privy dev app's JWT integration (see the
[dashboard steps](integration-guide.md#privy-dashboard-setup)):

- User ID claim: `sub`.
- Authentication environment: server side.
- Audience: `authenticated` (Supabase's default).
- Additional claim check on `iss`: the issuer your local stack puts in tokens.
  Decode a real token and copy the exact value, normally
  `http://127.0.0.1:54321/auth/v1`.

### Checking the commands

These commands were tested with a throwaway 2048-bit RSA key generated in a
temporary directory. The certificate came out as version 3 with
`sha256WithRSAEncryption` and an `rsaEncryption` 2048-bit public key. A JWT
signed with the PEM verified against the public key inside the certificate, and
the certificate's modulus equaled the `n` of the source JWK. You can repeat that
check with your own files:

```sh
node -e "
const c = require('crypto'), fs = require('fs');
const jwk = [].concat(JSON.parse(fs.readFileSync('path/to/signing_keys.json')))[0];
const cert = new c.X509Certificate(fs.readFileSync('local-jwt-cert.pem'));
console.log('cert key matches JWK:', cert.publicKey.export({ format: 'jwk' }).n === jwk.n);
"
```

## Getting a test user token

With the local stack running, create a user and sign in. `supabase status`
shows the API URL and the anon (publishable) key for the local stack; these are
local-only values.

```sh
API_URL=http://127.0.0.1:54321
ANON_KEY=...   # the anon / publishable key from `supabase status`

curl -s -X POST "$API_URL/auth/v1/signup" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"a-long-dev-password"}' >/dev/null

TEST_USER_JWT=$(curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"a-long-dev-password"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).access_token))")
export TEST_USER_JWT
```

The signup call errors harmlessly if the user already exists. Local projects
usually do not require email confirmation; if yours does, confirm the user in
the local mail inbox first.

Read the token's header to see which key signed it (useful when the key file has
more than one key):

```sh
node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[0], 'base64url')))" "$TEST_USER_JWT"
```

The header's `alg` must be `RS256`, and its `kid` must match the key you wrapped
in the certificate. Tokens last about an hour by default; get a new one when a
test reports `REAUTH_REQUIRED`.

Never paste real tokens into issues or logs.

## Integration tests against Privy

The tests in `test/integration` run only when these variables are set. Set the
secret without echoing it or leaving it in shell history:

```sh
export PRIVY_APP_ID=...                  # development app id
read -rs PRIVY_APP_SECRET && export PRIVY_APP_SECRET
export TEST_USER_JWT=...                 # a current token, see above

npx vitest run test/integration
```

- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `TEST_USER_JWT` enable the server test
  (`test/integration/server.test.ts`). It ensures a wallet twice, recovers it
  into an empty store, signs a message and verifies the signature, and reads
  back. It sends no transactions. The token's `sub` must be the claim Privy uses
  as the user id, and the token must be unexpired.
- Set `PRIVY_POLICY_TEST=1` as well to enable the policy test
  (`test/integration/policy.test.ts`). It asks Privy to accept the bodies
  `buildWalletPolicy` produces, then deletes the policies it created. It never
  attaches a policy to a wallet and never sends a transaction. If a deletion
  fails, the log says so; remove the leftover policy in the dashboard.

- Set `PRIVY_BATCH_TEST=1` as well to enable the sponsored batch test
  (`test/integration/batch.test.ts`). It sends one real batch of two
  zero-value calls from the wallet to itself on Sepolia (11155111) through
  Privy's `wallet_sendCalls`, replays it with the same `requestId`, and polls
  until it is confirmed (up to 3 minutes). It needs gas sponsorship enabled
  for Sepolia in the development app and spends sponsored gas credits. If the
  wallet carries a Privy policy without a `wallet_sendCalls` rule, expect
  `POLICY_DENIED`.

These tests create data in the development app (a user and a wallet for the
token's subject). Use a development app only.

## Running the example

`examples/supabase-appkit` is a Node server plus a Vite page with Supabase Auth
and Reown AppKit. It works as a manual test harness and as an end-to-end test
target (its buttons have stable `data-testid` values and `window.__demo`
exposes state and actions).

You need: the local Supabase stack above (or a hosted project with an
asymmetric signing key), the Privy dev app, and a Reown project id from the
Reown dashboard.

```sh
# at the repository root
npm install
npm run build

cd examples/supabase-appkit
cp .env.example .env     # then fill it in with your editor
npm install
```

Fill in `.env` using your editor, with these values for a local stack:

- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`: the development app.
- `SUPABASE_URL` and `VITE_SUPABASE_URL`: `http://127.0.0.1:54321`.
- `VITE_SUPABASE_ANON_KEY`: the local anon key.
- `VITE_REOWN_PROJECT_ID`: your Reown project id.
- `APP_ORIGIN`: leave unset to use `http://localhost:5173`.

Then run the two processes in separate terminals:

```sh
npx tsx --env-file=.env server.ts   # terminal 1: wallet server on 127.0.0.1:8787
npm run dev                         # terminal 2: Vite on http://localhost:5173
```

`npm run server` does not load `.env` by itself, which is why the first command
passes it.

Open `http://localhost:5173`. Sign in (the page creates the account on first
use), press the embedded wallet connect button, then sign a message, switch
network and send. The example configures Sepolia as sponsored and Hoodi as not
sponsored, with a hook that allows only an empty, zero-value transaction from
the wallet to itself. Anything else returns `POLICY_DENIED`.

For a sponsored send, Sepolia sponsorship must be enabled in the Privy dev app.
Remember that a sponsored send does not show in the wallet address's explorer
page; look it up by hash (see
[Sponsored transactions and block explorers](integration-guide.md#sponsored-transactions-and-block-explorers)).

`npm run typecheck` in the example folder checks it.

## Funding a test wallet

An unsponsored send needs the wallet to hold gas. Sponsored sends do not.

1. Connect the wallet in the example (or call `ensureWallet`) and copy its
   address from the page.
2. Pick an unsponsored testnet. The example uses Hoodi (chain id 560048), which
   Privy does not offer for sponsorship, so the wallet pays its own gas.
3. Get testnet currency for that address from a faucet for that network. Faucets
   change over time and many require an account, a captcha or a small mainnet
   balance, so search for a current faucet for the testnet rather than relying
   on a fixed list.
4. Check the balance in the chain's block explorer (viem's chain definition has
   its URL under `blockExplorers.default.url`), then send from the example.
   An unsponsored send is an ordinary transaction from the wallet and does show
   in the explorer's address page.

Testnet currency has no value. Never send real funds to a development wallet.
