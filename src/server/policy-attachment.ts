import type { PrivyGateway } from './privy/gateway';

/**
 * Whether a wallet carrying `current` satisfies the configured `required`
 * policies. Unknown (`undefined`) never does, so a record stored before
 * `policyIds` was configured is checked against Privy before it is used.
 */
export function carriesPolicies(
  current: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  if (!current) return false;
  return required.every((id) => current.includes(id));
}

/**
 * Sets the wallet's policies to `required`, authorized by the owner's JWT.
 * Returns the policies Privy reports afterwards when they satisfy `required`,
 * or null when Privy answered without attaching them. Throws `UpstreamError`
 * when the update fails.
 */
export async function attachPolicies(
  gateway: PrivyGateway,
  walletId: string,
  required: readonly string[],
  jwt: string,
): Promise<readonly string[] | null> {
  const updated = await gateway.updateWalletPolicies(walletId, required, jwt);
  if (updated.id !== walletId) return null;
  return carriesPolicies(updated.policyIds, required)
    ? updated.policyIds
    : null;
}
