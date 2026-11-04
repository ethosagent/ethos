/** The host cannot take a call right now (circuit open, restarting, disposed). */
export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostUnavailableError';
  }
}

/** The host failed to spawn, to become ready, or to activate the plugin. */
export class HostStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostStartError';
  }
}

/** Error codes a host sees in the message of a refused reverse call (plan §5.5, §5.6). */
export const HOST_ERROR = {
  handleRevoked: 'PLUGIN_HOST_HANDLE_REVOKED',
  secretDenied: 'PLUGIN_HOST_SECRET_DENIED',
  capabilityUnavailable: 'PLUGIN_HOST_CAPABILITY_UNAVAILABLE',
  /** `plugins.host.sandbox: auto` and no wrapper works (plan §5.8, D22). Never a fallback. */
  sandboxUnavailable: 'PLUGIN_HOST_SANDBOX_UNAVAILABLE',
} as const;
