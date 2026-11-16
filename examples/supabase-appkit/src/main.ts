import { createClient } from '@supabase/supabase-js';
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { hoodi, sepolia } from '@reown/appkit/networks';
import {
  connect,
  disconnect,
  getAccount,
  sendTransaction,
  signMessage,
  switchChain,
  watchAccount,
} from '@wagmi/core';
import { createPublicClient, http, type Address } from 'viem';
import { createEmbeddedWalletClient } from '@truflation/privy-embedded-wallet/client';
import {
  embeddedWallet,
  getEmbeddedWalletConnector,
} from '@truflation/privy-embedded-wallet/wagmi';

const BASE_PATH = '/api/wallets/embedded';
const CONNECTOR_ID = 'embedded-wallet';
const MESSAGE = 'Embedded wallet example message';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

const el = <T extends HTMLElement>(selector: string) =>
  document.querySelector(selector) as T;
const emailInput = el<HTMLInputElement>('#email');
const passwordInput = el<HTMLInputElement>('#password');
const notice = el<HTMLElement>('#notice');
const statusLine = el<HTMLElement>('#status');
const stateView = el<HTMLElement>('[data-testid="state"]');

let hasSession = false;

const walletClient = createEmbeddedWalletClient({
  basePath: BASE_PATH,
  headers: async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return { Authorization: token ? `Bearer ${token}` : undefined };
  },
});

const wagmiAdapter = new WagmiAdapter({
  projectId: import.meta.env.VITE_REOWN_PROJECT_ID,
  networks: [sepolia, hoodi],
  connectors: [
    embeddedWallet({
      client: walletClient,
      id: CONNECTOR_ID,
      name: 'Your account',
      hasSession: async () =>
        (await supabase.auth.getSession()).data.session !== null,
      onLoginRequired: () => {
        notice.textContent = 'Sign in to use your account wallet.';
        emailInput.focus();
      },
    }),
  ],
});
const config = wagmiAdapter.wagmiConfig;

const modal = createAppKit({
  adapters: [wagmiAdapter],
  projectId: import.meta.env.VITE_REOWN_PROJECT_ID,
  networks: [sepolia, hoodi],
  features: { email: false, socials: false, analytics: false },
});

interface ActionError {
  name: string;
  message: string;
  code: number | string | null;
}

const demo = {
  lastSignature: null as { ok: boolean } | null,
  lastTx: null as { hash: string } | null,
  lastError: null as ActionError | null,
};

function state() {
  const account = getAccount(config);
  const appKit = modal.getAccount();
  return {
    session: hasSession,
    wagmi: {
      status: account.status,
      address: account.address ?? null,
      chainId: account.chainId ?? null,
      connectorId: account.connector?.id ?? null,
    },
    appKit: {
      address: appKit?.address ?? null,
      connected: appKit?.isConnected ?? false,
      chainId: modal.getChainId() ?? null,
    },
    lastSignature: demo.lastSignature,
    lastTx: demo.lastTx,
    lastError: demo.lastError,
  };
}

const render = () => {
  stateView.textContent = JSON.stringify(state(), null, 2);
};

function recordError(error: unknown) {
  const e = error as { name?: string; message?: string; code?: unknown };
  const recorded = {
    name: e?.name ?? 'Error',
    message: e?.message ?? String(error),
    code:
      typeof e?.code === 'number' || typeof e?.code === 'string'
        ? e.code
        : null,
  };
  demo.lastError = recorded;
  return recorded;
}

/**
 * Runs an action, records any error instead of throwing, and re-renders. The
 * status line under the buttons says what is happening, because a send can
 * take a while and the JSON readout may be off screen on a phone.
 */
let busy = false;
async function run(label: string, action: () => Promise<string | void>) {
  if (busy) return;
  busy = true;
  demo.lastError = null;
  statusLine.textContent = `${label}...`;
  try {
    const result = await action();
    statusLine.textContent = result ? `${label}: ${result}` : `${label}: done`;
  } catch (error) {
    const recorded = recordError(error);
    statusLine.textContent = `${label} failed: ${recorded.message}`;
  } finally {
    busy = false;
  }
  render();
}

const embeddedConnector = () =>
  getEmbeddedWalletConnector(config, CONNECTOR_ID);

const verifierClient = createPublicClient({
  chain: sepolia,
  transport: http(),
});

const actions = {
  async signIn() {
    await run('Sign in', async () => {
      const credentials = {
        email: emailInput.value,
        password: passwordInput.value,
      };
      const first = await supabase.auth.signInWithPassword(credentials);
      if (!first.error) return;
      const up = await supabase.auth.signUp(credentials);
      if (up.error) throw up.error;
      if (!up.data.session) {
        const second = await supabase.auth.signInWithPassword(credentials);
        if (second.error) throw second.error;
      }
    });
  },
  async signOut() {
    await run('Sign out', async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    });
  },
  async connectEmbedded() {
    await run('Connect', async () => {
      const connector = embeddedConnector();
      if (!connector) throw new Error('Embedded connector not found.');
      const { accounts } = await connect(config, { connector });
      return String(accounts[0]);
    });
  },
  async openModal() {
    await run('Open modal', async () => {
      await modal.open();
    });
  },
  async disconnect() {
    await run('Disconnect', async () => {
      await disconnect(config);
    });
  },
  async signMessage() {
    await run('Sign message', async () => {
      const address = getAccount(config).address;
      if (!address) throw new Error('Not connected.');
      const signature = await signMessage(config, { message: MESSAGE });
      const ok = await verifierClient.verifyMessage({
        address,
        message: MESSAGE,
        signature,
      });
      demo.lastSignature = { ok };
      return ok ? 'signature verified' : 'signature did NOT verify';
    });
  },
  async switchChain(chainId: number) {
    await run('Switch network', async () => {
      await switchChain(config, { chainId });
    });
  },
  async sendTx() {
    await run('Send', async () => {
      const address = getAccount(config).address as Address | undefined;
      if (!address) throw new Error('Not connected.');
      const hash = await sendTransaction(config, { to: address, value: 0n });
      demo.lastTx = { hash };
      return `sent, hash ${hash}`;
    });
  },
};

function bind(testId: string, handler: () => void) {
  el(`[data-testid="${testId}"]`).addEventListener('click', handler);
}
bind('sign-in', () => void actions.signIn());
bind('sign-out', () => void actions.signOut());
bind('connect-embedded', () => void actions.connectEmbedded());
bind('open-modal', () => void actions.openModal());
bind('disconnect', () => void actions.disconnect());
bind('sign-message', () => void actions.signMessage());
bind('switch-hoodi', () => void actions.switchChain(hoodi.id));
bind('switch-sepolia', () => void actions.switchChain(sepolia.id));
bind('send-tx', () => void actions.sendTx());

supabase.auth.onAuthStateChange((event, session) => {
  hasSession = session !== null;
  if (hasSession) notice.textContent = '';
  if (event === 'SIGNED_OUT') embeddedConnector()?.notifySessionEnded();
  render();
});

watchAccount(config, { onChange: render });
modal.subscribeAccount(render);
modal.subscribeNetwork(render);

void supabase.auth.getSession().then(({ data }) => {
  hasSession = data.session !== null;
  render();
});

declare global {
  interface Window {
    __demo: { state: typeof state; actions: typeof actions };
  }
}
window.__demo = { state, actions };
render();
