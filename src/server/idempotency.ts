import { sha256, stringToBytes } from 'viem';

/**
 * Deterministic keys sent to Privy. Each is a SHA-256 over a domain tag and
 * its inputs, encoded as a JSON array so no choice of user id can make two
 * different input tuples hash the same text. The result is 64 hex characters,
 * safe as a header and opaque in Privy's dashboard and webhooks.
 */
function derive(tag: string, ...parts: unknown[]): string {
  return sha256(
    stringToBytes(JSON.stringify([`privy-embedded-wallet:${tag}`, ...parts])),
  ).slice(2);
}

/**
 * Wallet creation key, per Privy user and policy configuration. Including the
 * policy ids means a changed configuration never reuses a key whose cached
 * response is a wallet created under the old policy.
 */
export function walletIdempotencyKey(
  privyUserId: string,
  policyIds: readonly string[],
): string {
  return derive('create-wallet', privyUserId, [...policyIds].sort());
}

/**
 * Privy idempotency key for one send intent. The same user and `requestId`
 * always give the same key, so a retried request is answered from Privy's
 * idempotency cache instead of being sent again. The body is deliberately
 * not part of the key: a reused `requestId` with a different body must not
 * be able to send a second transaction.
 */
export function sendIdempotencyKey(userId: string, requestId: string): string {
  return derive('send-transaction', userId, requestId.toLowerCase());
}

/**
 * Privy `reference_id` for one send intent. Privy documents it as unique per
 * app, so it is scoped to the user like the idempotency key. It outlives the
 * idempotency window and is the second line of defence against a late retry.
 */
export function sendReferenceId(userId: string, requestId: string): string {
  return derive('send-reference', userId, requestId.toLowerCase());
}
