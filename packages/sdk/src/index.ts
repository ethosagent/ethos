export type { ApiKeyMetadata, ApiKeyScope, Contract, SseEvent } from '@ethosagent/web-contracts';
export { EthosClient } from './client';
export type { Dispatcher } from './dispatcher';
export { EthosError, type EthosErrorCode } from './error';
export { type CreateEthosClientOptions, createEthosClient } from './factory';
export { HttpDispatcher, type HttpDispatcherOptions } from './http-dispatcher';
export { EventStream, type EventStreamOptions, type EventStreamSubscription } from './stream';
