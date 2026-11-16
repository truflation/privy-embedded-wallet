import { getAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { ERROR_CODE, type Address, type Hex } from '../protocol/index';
import type { EmbeddedWalletClient } from './client';
import { EmbeddedWalletClientError } from './errors';

export interface ExportPrivateKeyOptions {
  /** The wallet address the page believes it is exporting. */
  address: Address;
}

const PRIVATE_KEY_PATTERN = /^(?:0x)?([0-9a-fA-F]{64})$/;

const toBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));

/** Throws on malformed base64 (`atob` is the only decoder in every browser). */
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const exportFailed = (message: string) =>
  new EmbeddedWalletClientError(ERROR_CODE.PROVIDER_ERROR, message, 0);

/**
 * Exports the wallet's private key, decrypted in this page only.
 *
 * Generates a one-time P-256 key pair with WebCrypto whose private half is
 * non-extractable, sends only the public half to the host, which forwards
 * it to Privy, and opens Privy's HPKE ciphertext here. The host server only
 * ever sees ciphertext. The result is checked to control `address`, so a
 * host cannot substitute a key it knows.
 *
 * Resolves with the key as `0x`-prefixed lowercase hex. The caller must
 * show it once, never log or store it, and drop every reference to it
 * afterwards. Server refusals reject with `EmbeddedWalletClientError`
 * carrying the protocol code (`POLICY_DENIED` when the host does not allow
 * export); a response that cannot be decrypted or does not match `address`
 * rejects with `PROVIDER_ERROR` and status 0.
 *
 * The suite, HPKE base mode with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
 * ChaCha20-Poly1305 and empty `info` and `aad`, is the one `@privy-io/node`
 * uses to decrypt its own exports. WebCrypto has no ChaCha20-Poly1305, so
 * `@hpke/*` is loaded on first use only.
 */
export async function exportPrivateKey(
  client: Pick<EmbeddedWalletClient, 'exportWallet'>,
  { address }: ExportPrivateKeyOptions,
): Promise<Hex> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw exportFailed('Key export needs WebCrypto (a secure context).');
  }
  const [
    { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 },
    { Chacha20Poly1305 },
  ] = await Promise.all([
    import('@hpke/core'),
    import('@hpke/chacha20poly1305'),
  ]);

  const recipientKey = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const spki = new Uint8Array(
    await subtle.exportKey('spki', recipientKey.publicKey),
  );
  const { ciphertext, encapsulatedKey } = await client.exportWallet({
    address,
    recipientPublicKey: toBase64(spki),
  });

  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  let plaintext: Uint8Array;
  try {
    const context = await suite.createRecipientContext({
      recipientKey,
      enc: fromBase64(encapsulatedKey),
    });
    plaintext = new Uint8Array(await context.open(fromBase64(ciphertext)));
  } catch {
    throw exportFailed('The exported key could not be decrypted.');
  }

  let privateKey: Hex;
  try {
    const match = PRIVATE_KEY_PATTERN.exec(new TextDecoder().decode(plaintext));
    if (!match)
      throw exportFailed('The exported key has an unexpected format.');
    privateKey = `0x${match[1]!.toLowerCase()}`;
  } finally {
    plaintext.fill(0);
  }
  if (privateKeyToAddress(privateKey) !== getAddress(address)) {
    throw exportFailed('The exported key does not belong to this wallet.');
  }
  return privateKey;
}
