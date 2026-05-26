import { randomUUID } from 'node:crypto';
import type { NotificationRouter, OAuthConfig } from '@ethosagent/types';

export class OAuthCoordinatorImpl {
  private readonly pending = new Map<string, {
    pluginId: string;
    sessionKey: string;
    config: OAuthConfig;
    pendingUserMessage: string;
    redirectUri: string;
  }>();

  beginFlow(opts: {
    pluginId: string;
    sessionKey: string;
    config: OAuthConfig;
    pendingUserMessage: string;
    redirectUri: string;
  }): string {
    const state = randomUUID();
    this.pending.set(state, opts);
    setTimeout(() => this.pending.delete(state), 10 * 60 * 1000);
    return state;
  }

  async handleCallback(
    code: string,
    state: string,
    notificationRouter: NotificationRouter,
  ): Promise<void> {
    const ctx = this.pending.get(state);
    if (!ctx) throw new Error('Unknown or expired OAuth state — flow may have timed out.');
    this.pending.delete(state);
    await ctx.config.onCallback({ code, redirectUri: ctx.redirectUri });
    await notificationRouter.route(ctx.pluginId, {
      sessionKey: ctx.sessionKey,
      message: ctx.pendingUserMessage,
      startTurn: true,
    });
  }

  cancelAll(pluginId: string): void {
    for (const [state, ctx] of this.pending) {
      if (ctx.pluginId === pluginId) this.pending.delete(state);
    }
  }
}
