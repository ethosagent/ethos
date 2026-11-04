export { createPluginActivator, type PluginActivatorOptions } from './activator';
export { HostConnection, RpcError } from './connection';
export { HostStartError, HostUnavailableError } from './errors';
export type { HostEventCategory, HostEventSink } from './events';
export {
  type HostEnvContext,
  type HostLease,
  type HostSpec,
  PluginHostPool,
  type PluginHostPoolOptions,
} from './pool';
export * from './protocol';
