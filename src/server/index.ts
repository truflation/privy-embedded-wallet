/**
 * Server entry point. Runs in Node only: it holds the Privy app secret and
 * is the only place `@privy-io/node` is used.
 */
export * from '../protocol/index';

export { createEmbeddedWalletService } from './service';
export type {
  AuthorizeExport,
  AuthorizeMessage,
  AuthorizeTransaction,
  BatchPosition,
  ChainConfig,
  EmbeddedWalletService,
  EmbeddedWalletServiceConfig,
  EnsureWalletResult,
  ExportAuthorizationRequest,
  MessageAuthorizationRequest,
  Session,
  SignMessageOptions,
  TransactionAuthorizationRequest,
  WalletResult,
} from './types';

export { createMemoryWalletStore } from './store';
export type { WalletRecord, WalletStore } from './store';

export { EmbeddedWalletError } from './errors';
export type { Logger } from './logger';

export { createRequestHandler } from './http/request-handler';
export type {
  RequestHandler,
  RequestHandlerOptions,
} from './http/request-handler';

export { buildWalletPolicy } from './policy';
export type { WalletPolicy, WalletPolicyOptions } from './policy';
