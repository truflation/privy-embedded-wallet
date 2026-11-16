import { describe, expect, it } from 'vitest';
import { ERROR_CODE } from '../../src/protocol/index';
import { decodeJwtPayload } from '../../src/server/session';
import type { Session } from '../../src/server/types';
import {
  OTHER_JWT,
  TEST_JWT,
  expectCode,
  makeJwt,
  session,
  setup,
} from './helpers';

describe('session checks (rule 4)', () => {
  it('rejects malformed sessions as UNAUTHENTICATED', async () => {
    const { service } = setup();
    for (const bad of [
      { userId: '', jwt: TEST_JWT },
      { userId: 'u', jwt: '' },
      { userId: 'x'.repeat(257), jwt: TEST_JWT },
      null,
    ]) {
      const s = bad as unknown as Session;
      await expectCode(service.ensureWallet(s), ERROR_CODE.UNAUTHENTICATED);
      await expectCode(service.getWallet(s), ERROR_CODE.UNAUTHENTICATED);
    }
  });

  it('rejects a token whose sub is another user, on every method', async () => {
    const { fake, service, log } = setup();
    await service.ensureWallet(session);
    const mismatched: Session = { userId: session.userId, jwt: OTHER_JWT };
    await expectCode(service.getWallet(mismatched), ERROR_CODE.UNAUTHENTICATED);
    await expectCode(
      service.ensureWallet(mismatched),
      ERROR_CODE.UNAUTHENTICATED,
    );
    await expectCode(
      service.signMessage(mismatched, {
        address: '0x1111111111111111111111111111111111111111',
        message: 'hi',
      }),
      ERROR_CODE.UNAUTHENTICATED,
    );
    await expectCode(
      service.getTransaction(mismatched, 'tx1'),
      ERROR_CODE.UNAUTHENTICATED,
    );
    expect(fake.calls.authorize).toHaveLength(0);
    // The mismatch is logged without either user id.
    expect(log.text()).toContain('does not match');
    expect(log.text()).not.toContain('user-2');
  });

  it.each([
    ['not a JWT', 'opaque-session-token'],
    ['two segments', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ'],
    ['a non-base64url payload', 'aaaa.not*base64.bbbb'],
    ['a payload that is not JSON', `aaaa.${btoa('nope')}.bbbb`],
    ['a JSON array payload', `aaaa.${btoa('["user-1"]')}.bbbb`],
    ['no sub claim', makeJwt({ uid: 'user-1' })],
    ['a numeric sub claim', makeJwt({ sub: 1 })],
    ['an oversized token', makeJwt({ sub: 'user-1', pad: 'x'.repeat(20000) })],
  ])('rejects a token with %s', async (_, jwt) => {
    const { service } = setup();
    await expectCode(
      service.getWallet({ userId: 'user-1', jwt }),
      ERROR_CODE.UNAUTHENTICATED,
    );
  });

  it('reads the configured userIdClaim instead of sub', async () => {
    const { service } = setup({ userIdClaim: 'app_user_id' });
    const jwt = makeJwt({ sub: 'provider-subject', app_user_id: 'user-1' });
    expect(await service.getWallet({ userId: 'user-1', jwt })).toBeNull();
    await expectCode(
      service.getWallet({ userId: 'provider-subject', jwt }),
      ERROR_CODE.UNAUTHENTICATED,
    );
  });

  it('does not read claims from the prototype chain', async () => {
    const { service } = setup({ userIdClaim: 'constructor' });
    await expectCode(
      service.getWallet({ userId: 'user-1', jwt: TEST_JWT }),
      ERROR_CODE.UNAUTHENTICATED,
    );
  });
});

describe('decodeJwtPayload', () => {
  it('decodes base64url payloads, including multi-byte UTF-8', () => {
    const jwt = makeJwt({ sub: 'user-ü', n: 1 });
    expect(decodeJwtPayload(jwt)).toEqual({ sub: 'user-ü', n: 1 });
  });
});
