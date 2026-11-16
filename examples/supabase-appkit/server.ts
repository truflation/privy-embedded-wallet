import { createServer, type IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  createEmbeddedWalletService,
  createMemoryWalletStore,
  createRequestHandler,
  type AuthorizeTransaction,
  type Session,
} from '@truflation/privy-embedded-wallet/server';

const REQUIRED_ENV = ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'SUPABASE_URL'];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Missing required environment variables: ${missing.join(', ')}`,
  );
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = 8787;
const BASE_PATH = '/api/wallets/embedded';
const SEPOLIA = 11155111;
const HOODI = 560048;

const supabaseUrl = process.env.SUPABASE_URL!.replace(/\/+$/, '');
const issuer = `${supabaseUrl}/auth/v1`;
const jwks = createRemoteJWKSet(
  new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
);

async function authenticate(request: Request): Promise<Session | null> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const jwt = match[1]!;
  try {
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer,
      audience: 'authenticated',
    });
    return payload.sub ? { userId: payload.sub, jwt } : null;
  } catch {
    return null;
  }
}

/**
 * The example's transaction rule: only an empty, zero-value transaction from
 * the wallet to itself, which is what the page's send button submits. The
 * server has already checked that `from` is the session's own wallet. A real
 * site would use a per-chain `allow` list of its contracts instead, or a hook
 * that applies its own limits.
 */
const onlyEmptySelfSends: AuthorizeTransaction = (_session, tx) =>
  tx.to.toLowerCase() === tx.from.toLowerCase() &&
  (tx.value === undefined || BigInt(tx.value) === 0n) &&
  (tx.data === undefined || tx.data === '0x');

const service = createEmbeddedWalletService({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
  store: createMemoryWalletStore(),
  chains: {
    // A sponsored chain needs an allow list or an authorizeTransaction hook,
    // otherwise any account could spend the app's gas budget on anything.
    [SEPOLIA]: { sponsor: true },
    [HOODI]: { sponsor: false },
  },
  authorizeTransaction: onlyEmptySelfSends,
  logger: {
    warn: (message, context) => console.warn(message, context),
    error: (message, context) => console.error(message, context),
  },
});

const handle = createRequestHandler(service, {
  basePath: BASE_PATH,
  authenticate,
  allowedOrigins: [process.env.APP_ORIGIN || 'http://localhost:5173'],
});

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? `${HOST}:${PORT}`}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const chunks: Buffer[] = [];
  if (hasBody) for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody && chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

createServer(async (req, res) => {
  try {
    const response = await handle(await toWebRequest(req));
    // Method, path and status only. Never log headers or bodies here.
    console.log(`${req.method} ${req.url?.split('?')[0]} ${response.status}`);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'PROVIDER_ERROR' } }));
  }
}).listen(PORT, HOST, () => {
  console.log(`Wallet server listening on http://${HOST}:${PORT}${BASE_PATH}`);
});
