import type { Hex } from '../protocol/index';
import { EmbeddedProviderError, RPC_ERROR_CODE } from './provider-errors';

/** Fields the provider reads from an `eth_sendTransaction` object. */
const HANDLED_FIELDS = new Set(['from', 'to', 'data', 'input', 'value']);

/**
 * Fields wallets and libraries send routinely. Privy sets gas and fees
 * itself, so they are dropped rather than rejected.
 */
const IGNORED_FIELDS = new Set([
  'gas',
  'gasLimit',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'type',
]);

export interface ParsedTransactionParams {
  from?: string;
  to: Hex;
  data?: Hex;
  value?: Hex;
}

const isHexString = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

const invalidParams = (message: string) =>
  new EmbeddedProviderError(RPC_ERROR_CODE.INVALID_PARAMS, message);

function toChainNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    return Number.parseInt(value, 16);
  }
  return null;
}

/**
 * Validates an `eth_sendTransaction` object. Fields whose value is
 * `undefined` count as absent. Anything the wallet cannot honour is rejected
 * with -32602 and the field named, never silently dropped.
 */
export function parseTransactionParams(
  tx: Record<string, unknown>,
  currentChainId: number,
): ParsedTransactionParams {
  for (const [field, value] of Object.entries(tx)) {
    if (value === undefined) continue;
    if (field === 'chainId') continue;
    if (HANDLED_FIELDS.has(field) || IGNORED_FIELDS.has(field)) continue;
    throw invalidParams(`The transaction field "${field}" is not supported.`);
  }

  if (
    tx.chainId !== undefined &&
    toChainNumber(tx.chainId) !== currentChainId
  ) {
    throw new EmbeddedProviderError(
      RPC_ERROR_CODE.CHAIN_DISCONNECTED,
      'The transaction chain does not match the current chain.',
    );
  }
  if (typeof tx.to !== 'string' || !isHexString(tx.to)) {
    throw invalidParams('Transactions need a "to" address.');
  }
  if (tx.from !== undefined && typeof tx.from !== 'string') {
    throw invalidParams('"from" must be an address.');
  }
  if (tx.data !== undefined && !isHexString(tx.data)) {
    throw invalidParams('"data" must be a hex string.');
  }
  if (tx.input !== undefined && !isHexString(tx.input)) {
    throw invalidParams('"input" must be a hex string.');
  }
  if (
    tx.data !== undefined &&
    tx.input !== undefined &&
    String(tx.data).toLowerCase() !== String(tx.input).toLowerCase()
  ) {
    throw invalidParams('"data" and "input" are both set and differ.');
  }
  if (tx.value !== undefined && !isHexString(tx.value)) {
    throw invalidParams('"value" must be a hex quantity.');
  }

  const parsed: ParsedTransactionParams = { to: tx.to };
  if (tx.from !== undefined) parsed.from = tx.from as string;
  const data = (tx.data ?? tx.input) as Hex | undefined;
  if (data !== undefined) parsed.data = data;
  if (tx.value !== undefined) parsed.value = tx.value as Hex;
  return parsed;
}
