import { randomUUID } from 'node:crypto';
export class OAuthCoordinatorImpl {
  pending = new Map();
  beginFlow(opts) {
    const state = randomUUID();
    this.pending.set(state, opts);
    setTimeout(() => this.pending.delete(state), 10 * 60 * 1000);
    return state;
  }
  async handleCallback(code, state, notificationRouter) {
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
  cancelAll(pluginId) {
    for (const [state, ctx] of this.pending) {
      if (ctx.pluginId === pluginId) this.pending.delete(state);
    }
  }
}
