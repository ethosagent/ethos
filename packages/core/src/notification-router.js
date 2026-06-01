export class DefaultNotificationRouter {
  adapters = new Map();
  async route(_pluginId, opts) {
    if (opts.sessionKey === '*') return;
    const adapter = this.adapters.get(opts.sessionKey);
    if (!adapter) return;
    if (opts.startTurn) {
      await adapter.injectUserMessage(opts.message);
    } else {
      await adapter.send(opts.message, opts.payload);
    }
  }
  register(sessionKey, adapter) {
    this.adapters.set(sessionKey, adapter);
  }
  deregister(sessionKey) {
    this.adapters.delete(sessionKey);
  }
}
