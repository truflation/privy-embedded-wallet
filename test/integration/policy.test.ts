import { APIError, PrivyClient } from '@privy-io/node';
import { describe, expect, it } from 'vitest';
import { buildWalletPolicy } from '../../src/server/index';
import { PRIVY_API_URL } from '../../src/server/privy/sdk-gateway';

/**
 * Checks that Privy accepts the policy body `buildWalletPolicy` emits, as
 * built: decimal chain id strings, checksummed addresses, a decimal `value`
 * ceiling, and a `personal_sign` rule with no conditions.
 *
 * Runs only when PRIVY_APP_ID, PRIVY_APP_SECRET, TEST_USER_JWT and
 * PRIVY_POLICY_TEST=1 are all set, against a Privy development app. It
 * creates policies and deletes them again. It never attaches a policy to a
 * wallet and never sends a transaction. Observations are logged with a
 * `[policy-test]` prefix; nothing secret and no upstream error text is
 * printed.
 */

// Read through globalThis to match the other integration test.
const env =
  (
    globalThis as {
      process?: { env: Record<string, string | undefined> };
    }
  ).process?.env ?? {};
const appId = env.PRIVY_APP_ID;
const appSecret = env.PRIVY_APP_SECRET;
const enabled = Boolean(
  appId && appSecret && env.TEST_USER_JWT && env.PRIVY_POLICY_TEST === '1',
);

const SEPOLIA = 11155111;
/**
 * Multicall3, deployed at the same address on Sepolia and most chains. The
 * policy is never attached to a wallet, so the choice only needs to be a
 * real, well-known contract.
 */
const HARMLESS_CONTRACT = '0xcA11bde05977b3631167028862bE2a173976CA11';

const observe = (message: string, detail?: unknown) =>
  console.info(`[policy-test] ${message}`, detail ?? '');

function statusOf(error: unknown): string {
  return error instanceof APIError ? String(error.status) : 'no status';
}

describe.skipIf(!enabled)('wallet policy against a Privy dev app', () => {
  const privy = () =>
    new PrivyClient({
      appId: appId!,
      appSecret: appSecret!,
      apiUrl: PRIVY_API_URL,
      logLevel: 'off',
    });

  async function createAndInspect(
    label: string,
    policy: ReturnType<typeof buildWalletPolicy>,
  ) {
    const client = privy();
    let id: string | undefined;
    try {
      const created = await client.policies().create(policy);
      id = created.id;
      expect(typeof created.id).toBe('string');
      observe(`${label}: accepted as built`, { policyId: created.id });
      for (const rule of created.rules) {
        observe(`${label}: Privy stored rule "${rule.name}"`, {
          method: rule.method,
          action: rule.action,
          conditions: rule.conditions,
        });
      }
      expect(created.rules.map((r) => r.method).sort()).toEqual(
        policy.rules.map((r) => r.method).sort(),
      );
      const sign = created.rules.find((r) => r.method === 'personal_sign');
      expect(sign?.conditions).toEqual([]);
    } catch (error) {
      if (id === undefined) {
        observe(`${label}: REJECTED by Privy`, { status: statusOf(error) });
      }
      throw error;
    } finally {
      if (id !== undefined) {
        try {
          await client.policies().delete(id, {});
          observe(`${label}: deleted`, { policyId: id });
        } catch (error) {
          observe(`${label}: could not delete; remove it in the dashboard`, {
            policyId: id,
            status: statusOf(error),
          });
        }
      }
    }
  }

  it('accepts a contract allow list and an unconditional personal_sign rule', async () => {
    await createAndInspect(
      'allow list',
      buildWalletPolicy({
        contracts: { [SEPOLIA]: [HARMLESS_CONTRACT] },
        allowPersonalSign: true,
        name: `privy-embedded-wallet policy test ${new Date().toISOString()}`,
      }),
    );
  }, 60_000);

  it('accepts a decimal value ceiling', async () => {
    await createAndInspect(
      'value ceiling',
      buildWalletPolicy({
        contracts: { [SEPOLIA]: [HARMLESS_CONTRACT] },
        maxValue: { [SEPOLIA]: 10n ** 15n },
        allowPersonalSign: true,
        name: `privy-embedded-wallet value test ${new Date().toISOString()}`,
      }),
    );
  }, 60_000);
});
