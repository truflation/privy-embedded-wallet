import { hexToBytes, isAddress } from 'viem';
import {
  ERROR_CODE,
  type Address,
  type ExportWalletRequest,
  type Hex,
  type SignMessageRequest,
  type SignableMessage,
  type TransactionRequest,
} from '../protocol/index';
import { walletError } from './errors';
import {
  MAX_MESSAGE_BYTES,
  MAX_TRANSACTION_DATA_BYTES,
  MAX_TRANSACTION_ID_LENGTH,
  MAX_UINT256,
  P256_SPKI_BYTES,
  P256_SPKI_PREFIX,
  REQUEST_ID_PATTERN,
  TRANSACTION_ID_PATTERN,
} from './limits';

/**
 * Strict validators shared by the request handler (untrusted JSON) and the
 * service (host code calling it directly). Every failure is an
 * `INVALID_REQUEST` whose message names the field but never echoes its value.
 */

function invalid(message: string) {
  return walletError(ERROR_CODE.INVALID_REQUEST, message);
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function expectObject(
  value: unknown,
  name: string,
  allowed: readonly string[],
): PlainObject {
  if (!isPlainObject(value)) throw invalid(`${name} must be a JSON object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(`${name} has an unknown field.`);
    }
  }
  return value;
}

// Even-length hex with a 0x prefix. Hex quantities are checked separately.
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
// Canonical hex quantity: no leading zeros except the single digit 0.
const HEX_QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
// A UTF-16 surrogate without its pair. Such strings have no exact UTF-8 form.
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function expectHexBytes(value: unknown, name: string, maxBytes: number): Hex {
  if (typeof value !== 'string' || value.length > 2 + maxBytes * 2) {
    throw invalid(`${name} must be hex of at most ${maxBytes} bytes.`);
  }
  if (!HEX_BYTES_PATTERN.test(value)) {
    throw invalid(`${name} must be 0x-prefixed, even-length hex.`);
  }
  return value as Hex;
}

/** Result of validating a message: the wire form and the bytes to sign. */
export interface ParsedMessage {
  message: SignableMessage;
  bytes: Uint8Array;
}

const textEncoder = new TextEncoder();

export function parseSignableMessage(message: unknown): ParsedMessage {
  if (typeof message === 'string') {
    if (message.length === 0) throw invalid('message must not be empty.');
    if (LONE_SURROGATE_PATTERN.test(message)) {
      throw invalid('message must be valid Unicode text.');
    }
    const bytes = textEncoder.encode(message);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      throw invalid(`message must be at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    return { message, bytes };
  }
  const object = expectObject(message, 'message', ['raw']);
  const raw = expectHexBytes(object.raw, 'message.raw', MAX_MESSAGE_BYTES);
  if (raw.length === 2) throw invalid('message.raw must not be empty.');
  return { message: { raw }, bytes: hexToBytes(raw) };
}

export function parseSignMessageRequest(body: unknown): {
  request: SignMessageRequest;
  bytes: Uint8Array;
} {
  const object = expectObject(body, 'body', ['address', 'message']);
  const address = parseAddress(object.address, 'address');
  const { message, bytes } = parseSignableMessage(object.message);
  return { request: { address, message }, bytes };
}

export function parseChainId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid('chainId must be a positive integer.');
  }
  return value;
}

export function parseAddress(value: unknown, name: string): Address {
  // strict: a mixed-case address must carry a valid EIP-55 checksum.
  if (typeof value !== 'string' || !isAddress(value, { strict: true })) {
    throw invalid(`${name} must be an Ethereum address.`);
  }
  return value;
}

function parseQuantity(value: unknown, name: string): Hex {
  if (
    typeof value !== 'string' ||
    value.length > 2 + 64 ||
    !HEX_QUANTITY_PATTERN.test(value) ||
    BigInt(value) > MAX_UINT256
  ) {
    throw invalid(`${name} must be a hex quantity such as 0x0.`);
  }
  return value as Hex;
}

/** A UUID, returned lowercased so retries differing only in case match. */
export function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw invalid('requestId must be a UUID.');
  }
  return value.toLowerCase();
}

export function parseTransactionRequest(body: unknown): TransactionRequest {
  const object = expectObject(body, 'body', [
    'requestId',
    'from',
    'chainId',
    'to',
    'data',
    'value',
  ]);
  const request: TransactionRequest = {
    requestId: parseRequestId(object.requestId),
    from: parseAddress(object.from, 'from'),
    chainId: parseChainId(object.chainId),
    to: parseAddress(object.to, 'to'),
  };
  if (object.data !== undefined) {
    request.data = expectHexBytes(
      object.data,
      'data',
      MAX_TRANSACTION_DATA_BYTES,
    );
  }
  if (object.value !== undefined) {
    request.value = parseQuantity(object.value, 'value');
  }
  return request;
}

export function parseTransactionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TRANSACTION_ID_LENGTH ||
    !TRANSACTION_ID_PATTERN.test(value)
  ) {
    throw invalid('Transaction id is not valid.');
  }
  return value;
}

/** `POST /wallet` takes no parameters: an empty body or `{}`. */
export function parseEmptyBody(body: unknown): void {
  expectObject(body, 'body', []);
}

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes standard, padded base64 and returns null for anything else,
 * including encodings that only decode by ignoring stray bits.
 */
export function decodeCanonicalBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return null;
  const binary = atob(value);
  if (btoa(binary) !== value) return null;
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * `recipientPublicKey` must be base64 of exactly a P-256 SPKI with an
 * uncompressed point. Whether the point is on the curve is left to Privy.
 */
export function parseExportWalletRequest(body: unknown): ExportWalletRequest {
  const object = expectObject(body, 'body', ['address', 'recipientPublicKey']);
  const address = parseAddress(object.address, 'address');
  const key = decodeCanonicalBase64(object.recipientPublicKey);
  if (
    !key ||
    key.length !== P256_SPKI_BYTES ||
    P256_SPKI_PREFIX.some((byte, i) => key[i] !== byte)
  ) {
    throw invalid(
      'recipientPublicKey must be a base64 P-256 SubjectPublicKeyInfo.',
    );
  }
  return {
    address,
    recipientPublicKey: object.recipientPublicKey as string,
  };
}
