import {
  MAX_BATCH_CALLS,
  TRANSACTION_STATUS,
  type Address,
  type BatchCall,
  type Hex,
  type TransactionResponse,
} from '../protocol/index';
import { EmbeddedProviderError, RPC_ERROR_CODE } from './provider-errors';

/**
 * EIP-5792 (`wallet_sendCalls`, `wallet_getCallsStatus`,
 * `wallet_getCapabilities`) request parsing and response shaping, in the
 * 2.0.0 form viem implements.
 */

export const EIP5792_VERSION = '2.0.0';

/** EIP-5792 batch status codes this wallet reports. */
export const CALLS_STATUS = {
  /** Submitted, not yet included on chain. */
  PENDING: 100,
  /** Included on chain and successful. */
  CONFIRMED: 200,
  /** Failed without reaching the chain. The wallet will not retry it. */
  OFFCHAIN_FAILURE: 400,
  /** Included on chain and reverted. Atomic, so nothing took effect. */
  REVERTED: 500,
} as const;

/** EIP-5792 `atomic` capability values. */
export const ATOMIC_STATUS = {
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
} as const;

/** One receipt in the EIP-5792 status shape, with hex quantities. */
export interface CallsReceipt {
  logs: { address: Address; data: Hex; topics: Hex[] }[];
  status: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  transactionHash: Hex;
}

export interface CallsStatus {
  version: string;
  id: string;
  chainId: Hex;
  status: number;
  atomic: true;
  receipts?: CallsReceipt[];
}

export interface ParsedSendCalls {
  chainId: number;
  calls: BatchCall[];
}

const SEND_CALLS_FIELDS = new Set([
  'version',
  'id',
  'from',
  'chainId',
  'atomicRequired',
  'calls',
  'capabilities',
]);
const CALL_FIELDS = new Set(['to', 'data', 'value', 'capabilities']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isHexString = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

const invalidParams = (message: string) =>
  new EmbeddedProviderError(RPC_ERROR_CODE.INVALID_PARAMS, message);

export function toChainNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    return Number.parseInt(value, 16);
  }
  return null;
}

export const toHexQuantity = (n: number): Hex => `0x${n.toString(16)}`;

/**
 * Capabilities are honoured or refused, never silently dropped: any
 * capability not marked `optional: true` is refused with 5700, because this
 * wallet supports none beyond atomic batching.
 */
function assertOptionalCapabilities(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidParams(`${name} must be an object.`);
  for (const [key, capability] of Object.entries(value)) {
    if (capability === undefined) continue;
    if (!isRecord(capability) || capability.optional !== true) {
      throw new EmbeddedProviderError(
        RPC_ERROR_CODE.UNSUPPORTED_NON_OPTIONAL_CAPABILITY,
        `The capability "${key}" is not supported by this wallet.`,
      );
    }
  }
}

function parseCall(raw: unknown, index: number): BatchCall {
  const name = `calls[${index}]`;
  if (!isRecord(raw)) throw invalidParams(`${name} must be an object.`);
  for (const [field, value] of Object.entries(raw)) {
    if (value === undefined || CALL_FIELDS.has(field)) continue;
    throw invalidParams(`The call field "${field}" is not supported.`);
  }
  assertOptionalCapabilities(raw.capabilities, `${name}.capabilities`);
  if (typeof raw.to !== 'string' || !isHexString(raw.to)) {
    throw invalidParams(`${name} needs a "to" address.`);
  }
  if (raw.data !== undefined && !isHexString(raw.data)) {
    throw invalidParams(`${name}.data must be a hex string.`);
  }
  if (raw.value !== undefined && !isHexString(raw.value)) {
    throw invalidParams(`${name}.value must be a hex quantity.`);
  }
  const call: BatchCall = { to: raw.to };
  if (raw.data !== undefined) call.data = raw.data;
  if (raw.value !== undefined) call.value = raw.value;
  return call;
}

/**
 * Validates `wallet_sendCalls` params. Refuses, with the EIP-5792 code, a
 * chain the server does not batch on (5710, or 5760 when the request
 * requires atomicity), more than `MAX_BATCH_CALLS` calls (5740), and
 * non-optional capabilities (5700). It never falls back to sending the
 * calls one by one.
 */
export function parseSendCallsParams(
  raw: unknown,
  context: {
    wallet: Address;
    currentChainId: number;
    chainIds: readonly number[];
    batchChainIds: readonly number[];
  },
): ParsedSendCalls {
  if (!isRecord(raw)) throw invalidParams('wallet_sendCalls expects [batch].');
  for (const [field, value] of Object.entries(raw)) {
    if (value === undefined || SEND_CALLS_FIELDS.has(field)) continue;
    throw invalidParams(
      `The wallet_sendCalls field "${field}" is not supported.`,
    );
  }
  if (raw.version !== undefined && raw.version !== EIP5792_VERSION) {
    throw invalidParams(
      `wallet_sendCalls version ${String(raw.version)} is not supported; use ${EIP5792_VERSION}.`,
    );
  }
  // Batch ids are Privy's transaction ids, so a caller-chosen id cannot be
  // honoured. Refused rather than replaced with a different one.
  if (raw.id !== undefined) {
    throw invalidParams('A caller-supplied batch id is not supported.');
  }
  if (
    raw.atomicRequired !== undefined &&
    typeof raw.atomicRequired !== 'boolean'
  ) {
    throw invalidParams('"atomicRequired" must be a boolean.');
  }
  if (raw.from !== undefined) {
    if (typeof raw.from !== 'string') {
      throw invalidParams('"from" must be an address.');
    }
    if (raw.from.toLowerCase() !== context.wallet.toLowerCase()) {
      throw new EmbeddedProviderError(
        RPC_ERROR_CODE.UNAUTHORIZED,
        'The "from" address is not the connected wallet.',
      );
    }
  }
  assertOptionalCapabilities(raw.capabilities, 'capabilities');

  const chainId =
    raw.chainId === undefined
      ? context.currentChainId
      : toChainNumber(raw.chainId);
  if (chainId === null)
    throw invalidParams('"chainId" must be a hex chain id.');
  if (!context.batchChainIds.includes(chainId)) {
    const atomicityOnly =
      raw.atomicRequired === true && context.chainIds.includes(chainId);
    throw new EmbeddedProviderError(
      atomicityOnly
        ? RPC_ERROR_CODE.ATOMICITY_NOT_SUPPORTED
        : RPC_ERROR_CODE.UNSUPPORTED_CHAIN_ID,
      `Batched calls are not supported on chain ${toHexQuantity(chainId)}.`,
    );
  }

  if (!Array.isArray(raw.calls) || raw.calls.length === 0) {
    throw invalidParams('"calls" must be a non-empty array.');
  }
  if (raw.calls.length > MAX_BATCH_CALLS) {
    throw new EmbeddedProviderError(
      RPC_ERROR_CODE.BUNDLE_TOO_LARGE,
      `A batch may have at most ${MAX_BATCH_CALLS} calls.`,
    );
  }
  return { chainId, calls: raw.calls.map(parseCall) };
}

/** The status code for a transaction, before any receipt is considered. */
export function callsStatusCode(tx: TransactionResponse): number {
  switch (tx.status) {
    case TRANSACTION_STATUS.CONFIRMED:
      return CALLS_STATUS.CONFIRMED;
    case TRANSACTION_STATUS.FAILED:
      // With a hash it reached the chain and reverted; without, it never did.
      return tx.hash ? CALLS_STATUS.REVERTED : CALLS_STATUS.OFFCHAIN_FAILURE;
    default:
      return CALLS_STATUS.PENDING;
  }
}

const isHexArray = (value: unknown): value is Hex[] =>
  Array.isArray(value) && value.every(isHexString);

/**
 * Picks the EIP-5792 receipt fields from an `eth_getTransactionReceipt`
 * result. Returns null when there is no receipt yet or it is malformed.
 */
export function toCallsReceipt(raw: unknown): CallsReceipt | null {
  if (!isRecord(raw) || !Array.isArray(raw.logs)) return null;
  const { status, blockHash, blockNumber, gasUsed, transactionHash } = raw;
  if (
    !isHexString(status) ||
    !isHexString(blockHash) ||
    !isHexString(blockNumber) ||
    !isHexString(gasUsed) ||
    !isHexString(transactionHash)
  ) {
    return null;
  }
  const logs: CallsReceipt['logs'] = [];
  for (const log of raw.logs as unknown[]) {
    if (
      !isRecord(log) ||
      !isHexString(log.address) ||
      !isHexString(log.data) ||
      !isHexArray(log.topics)
    ) {
      return null;
    }
    logs.push({ address: log.address, data: log.data, topics: log.topics });
  }
  return { logs, status, blockHash, blockNumber, gasUsed, transactionHash };
}

/**
 * `wallet_getCapabilities` result for the given chains: `atomic` is
 * `supported` exactly where the server accepts a batch.
 */
export function capabilitiesFor(
  chainIds: readonly number[],
  batchChainIds: readonly number[],
): Record<Hex, { atomic: { status: string } }> {
  const result: Record<Hex, { atomic: { status: string } }> = {};
  for (const chainId of chainIds) {
    result[toHexQuantity(chainId)] = {
      atomic: {
        status: batchChainIds.includes(chainId)
          ? ATOMIC_STATUS.SUPPORTED
          : ATOMIC_STATUS.UNSUPPORTED,
      },
    };
  }
  return result;
}
