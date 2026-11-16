import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@privy-io/node';
import { describe, expect, it } from 'vitest';
import { redact } from '../../src/server/logger';
import {
  UpstreamError,
  toUpstreamError,
} from '../../src/server/privy/upstream-error';
import { TEST_JWT } from './helpers';

const sdkError = (status: number, body: object = { error: 'nope' }) =>
  APIError.generate(status, body, undefined, new Headers());

describe('toUpstreamError', () => {
  it.each([
    [400, 'rejected'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'rejected'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('classifies SDK status %i as %s', (status, kind) => {
    const error = toUpstreamError(sdkError(status), 'op');
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.operation).toBe('op');
  });

  it('classifies connection failures and timeouts as unavailable', () => {
    expect(toUpstreamError(new APIConnectionError({}), 'op').kind).toBe(
      'unavailable',
    );
    expect(toUpstreamError(new APIConnectionTimeoutError(), 'op').kind).toBe(
      'unavailable',
    );
  });

  it('classifies anything else as unknown', () => {
    expect(toUpstreamError(new Error('boom'), 'op').kind).toBe('unknown');
    expect(toUpstreamError('boom', 'op').kind).toBe('unknown');
  });

  it('keeps redacted upstream text for logs, not in its message', () => {
    const error = toUpstreamError(
      sdkError(400, { error: `invalid token ${TEST_JWT}` }),
      'op',
    );
    expect(error.detail).toContain('invalid token');
    expect(error.detail).not.toContain(TEST_JWT);
    expect(error.message).not.toContain('invalid token');
  });
});

describe('redact', () => {
  it('removes JWTs, bearer tokens and signatures, and truncates', () => {
    const signature = `0x${'a1'.repeat(65)}`;
    const address = '0x1111111111111111111111111111111111111111';
    const out = redact(
      `jwt ${TEST_JWT} auth Bearer abc.def sig ${signature} addr ${address}`,
    );
    expect(out).not.toContain(TEST_JWT);
    expect(out).not.toContain('abc.def');
    expect(out).not.toContain(signature);
    expect(out).toContain(address);
    expect(redact('x'.repeat(2000)).length).toBeLessThan(600);
  });
});
