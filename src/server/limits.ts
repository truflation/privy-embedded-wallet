/**
 * Size and shape limits enforced on every request. They bound memory use and
 * keep obviously malformed input away from Privy.
 */

/** Largest message `personal_sign` accepts, in bytes (UTF-8 or raw). */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Largest transaction `data` accepted, in bytes. */
export const MAX_TRANSACTION_DATA_BYTES = 64 * 1024;

/**
 * Largest total `data` across the calls of one batch, in bytes. The same as
 * one transaction's, so a batch never needs a larger request body.
 */
export const MAX_BATCH_DATA_BYTES = MAX_TRANSACTION_DATA_BYTES;

/**
 * Largest request body read, in bytes. Large enough for the biggest valid
 * transaction or batch (hex doubles the data size) plus JSON overhead.
 */
export const MAX_BODY_BYTES = MAX_TRANSACTION_DATA_BYTES * 2 + 4 * 1024;

/** Largest uint256, the ceiling for a transaction `value`. */
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Longest transaction id accepted in `GET /transactions/:id`. */
export const MAX_TRANSACTION_ID_LENGTH = 128;

/** Characters allowed in a transaction id. Privy ids are URL-safe. */
export const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Longest host user id accepted in a session. */
export const MAX_USER_ID_LENGTH = 256;

/** Longest session JWT decoded. Bounds the work done before Privy sees it. */
export const MAX_JWT_LENGTH = 16 * 1024;

/**
 * A transaction `requestId`: a UUID in its canonical 8-4-4-4-12 hex form,
 * any version. Compared lowercased, so case does not change its identity.
 */
export const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Upper bound on wallets scanned when recovering a user's wallet from Privy.
 * A user normally has one; this only stops a runaway pagination loop.
 */
export const MAX_WALLETS_SCANNED = 100;

/** Privy currently enforces at most one policy per wallet. */
export const MAX_POLICY_IDS = 1;

/**
 * DER SubjectPublicKeyInfo header of an uncompressed P-256 public key:
 * id-ecPublicKey with the prime256v1 curve, followed by a 66-byte bit
 * string whose first byte is the unused-bits count (0) and second the
 * uncompressed point marker (0x04). This is what WebCrypto's
 * `exportKey('spki')` produces for a P-256 key, and what `@privy-io/node`
 * sends as `recipient_public_key` on export.
 */
export const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  0x04,
]);

/** Exact decoded length of an export `recipientPublicKey`. */
export const P256_SPKI_BYTES = 91;

/** Exact decoded length of an HPKE encapsulated key for DHKEM(P-256). */
export const P256_POINT_BYTES = 65;

/** The ChaCha20-Poly1305 tag: the shortest possible export ciphertext. */
export const AEAD_TAG_BYTES = 16;

/**
 * Largest export ciphertext passed back to the browser, in bytes. A private
 * key is well under this; it only bounds a malformed upstream response.
 */
export const MAX_EXPORT_CIPHERTEXT_BYTES = 1024;
