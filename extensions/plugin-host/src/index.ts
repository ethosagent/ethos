export { createPluginActivator, type PluginActivatorOptions } from './activator';
export { HostConnection, RpcError } from './connection';
export { HOST_ERROR, HostStartError, HostUnavailableError } from './errors';
export type { HostEventCategory, HostEventSink } from './events';
export {
  createParentHandlers,
  defaultAuthorizeSecretRef,
  ParentApis,
  type ParentHandlerDeps,
  type ParentServices,
  type SecretRefAuthorizer,
} from './parent-handlers';
export {
  type HostEnvContext,
  type HostLease,
  type HostSpec,
  PluginHostPool,
  type PluginHostPoolOptions,
} from './pool';
export * from './protocol';
