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
