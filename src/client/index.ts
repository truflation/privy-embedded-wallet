export * from '../protocol/index';
export {
  createEmbeddedWalletClient,
  type EmbeddedWalletClient,
  type EmbeddedWalletClientOptions,
  type HeaderValues,
} from './client';
export { EmbeddedWalletClientError, LoginRequiredError } from './errors';
export { exportPrivateKey, type ExportPrivateKeyOptions } from './export';
export {
  createEmbeddedProvider,
  type CreateEmbeddedProviderOptions,
  type EmbeddedProvider,
} from './provider';
export { EmbeddedProviderError, RPC_ERROR_CODE } from './provider-errors';
