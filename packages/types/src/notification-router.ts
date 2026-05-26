import type { NotifyOptions } from './monitor';

export interface NotificationAdapter {
  send(message: string, payload?: Record<string, unknown>): Promise<void>;
  injectUserMessage(message: string): Promise<void>;
}

export interface NotificationRouter {
  route(pluginId: string, opts: NotifyOptions): Promise<void>;
  register(sessionKey: string, adapter: NotificationAdapter): void;
  deregister(sessionKey: string): void;
}
