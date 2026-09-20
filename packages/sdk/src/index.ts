export type { ApiKeyMetadata, ApiKeyScope, Contract, SseEvent } from '@ethosagent/web-contracts';
export { EthosClient } from './client';
export {
  normalizeRemoteUrl,
  type ProbeConnectionOptions,
  type ProbeConnectionResult,
  probeConnection,
  remoteHost,
  remoteOrigin,
  wsOriginFor,
} from './connection';
export type { Dispatcher } from './dispatcher';
export { EthosError, type EthosErrorCode } from './error';
export { type CreateEthosClientOptions, createEthosClient } from './factory';
export { HttpDispatcher, type HttpDispatcherOptions } from './http-dispatcher';
export {
  type EventSchema,
  EventStream,
  type EventStreamOptions,
  type EventStreamSubscription,
} from './stream';
