import type { NotificationAdapter, NotificationRouter, NotifyOptions } from '@ethosagent/types';

export class DefaultNotificationRouter implements NotificationRouter {
  private readonly adapters = new Map<string, NotificationAdapter>();

  async route(_pluginId: string, opts: NotifyOptions): Promise<void> {
    if (opts.sessionKey === '*') return;
    const adapter = this.adapters.get(opts.sessionKey);
    if (!adapter) return;
    if (opts.startTurn) {
      await adapter.injectUserMessage(opts.message);
    } else {
      await adapter.send(opts.message, opts.payload);
    }
  }

  register(sessionKey: string, adapter: NotificationAdapter): void {
    this.adapters.set(sessionKey, adapter);
  }

  deregister(sessionKey: string): void {
    this.adapters.delete(sessionKey);
  }
}
