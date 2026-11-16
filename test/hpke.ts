import * as cryptography from '../node_modules/@privy-io/node/lib/cryptography.js';

/**
 * Plays Privy's side of an export: HPKE-encrypts a private key to the
 * recipient's public key with `@privy-io/node`'s own HPKE sender
 * (`setupHPKESender` in `lib/cryptography.js`). That module is internal to
 * the SDK and not in its `exports` map, so it is imported by file path. It
 * uses the same suite as the SDK's export recipient (`setupHPKERecipient`
 * in the same file).
 */

interface PrivyHpkeSender {
  encryptPayload(
    publicKey: Uint8Array,
    payload: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; encapsulatedKey: Uint8Array }>;
}
interface PrivyHpkeRecipient {
  publicKeySpki: Uint8Array;
  decryptPayload(enc: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
}
interface PrivyCryptography {
  setupHPKESender(): Promise<PrivyHpkeSender>;
  setupHPKERecipient(): Promise<PrivyHpkeRecipient>;
}

export const privyCryptography = cryptography as unknown as PrivyCryptography;

/** Length of the DER header in front of the raw point in a P-256 SPKI. */
const SPKI_HEADER_BYTES = 26;

export const toBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
export const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Encrypts `plaintext` (UTF-8) to a base64 SPKI public key. */
export async function hpkeSeal(
  recipientPublicKey: string,
  plaintext: string,
): Promise<{ ciphertext: string; encapsulatedKey: string }> {
  const spki = fromBase64(recipientPublicKey);
  const sender = await privyCryptography.setupHPKESender();
  const { ciphertext, encapsulatedKey } = await sender.encryptPayload(
    spki.subarray(SPKI_HEADER_BYTES),
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: toBase64(ciphertext),
    encapsulatedKey: toBase64(encapsulatedKey),
  };
}
