// V-CC-4 follow-up — the adapter classifies its own start failures. A token
// Slack refuses (`invalid_auth`, `not_authed`, `token_revoked`,
// `token_expired`, `account_inactive`) is thrown from `start()` with
// `permanent: true`, so the gateway's adapter-start retry
// (`isPermanentAdapterStartError`, apps/ethos/src/commands/gateway.ts) stops
// instead of retrying a dead token for ever. Any other `auth.test` failure
// stays non-fatal, and any other Socket Mode start failure is thrown as-is.

import boltPkg from '@slack/bolt';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackAdapter, type SlackAdapterConfig } from '../adapter';
import { loadSlackSdk } from '../sdk';

beforeAll(async () => {
  await loadSlackSdk();
});

// Bolt's `App` constructor fires `auth.test` eagerly; stub the WebClient's one
// dispatch method on its prototype so construction makes no network call (the
// same seam webhook-mode.test.ts uses).
const { App, HTTPReceiver } = boltPkg;
const probeApp = new App({
  receiver: new HTTPReceiver({ signingSecret: 's' }),
  authorize: async () => ({ botToken: 'xoxb-fake', botUserId: 'UBOT', botId: 'BBOT' }),
});
const webClientProto = Object.getPrototypeOf(probeApp.client) as {
  apiCall: (...args: unknown[]) => Promise<unknown>;
};
vi.spyOn(webClientProto, 'apiCall').mockResolvedValue({ ok: true, user_id: 'UBOT' });

function config(over: Partial<SlackAdapterConfig> = {}): SlackAdapterConfig {
  return {
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 's',
    botKey: 'bot-1',
    ...over,
  };
}

/** @slack/web-api's `slack_webapi_platform_error` shape. */
function platformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code },
  });
}

function withAuthTest(adapter: SlackAdapter, impl: () => Promise<unknown>): void {
  (adapter as unknown as { client: unknown }).client = { auth: { test: impl } };
}

async function startError(adapter: SlackAdapter): Promise<unknown> {
  return adapter.start().then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('SlackAdapter.start — permanent start errors', () => {
  for (const code of [
    'invalid_auth',
    'not_authed',
    'token_revoked',
    'token_expired',
    'account_inactive',
  ]) {
    it(`an auth.test ${code} fails start with a permanent error`, async () => {
      const adapter = new SlackAdapter(config({ mode: { http: true, socket: false } }));
      const cause = platformError(code);
      withAuthTest(adapter, () => Promise.reject(cause));
      const thrown = await startError(adapter);
      expect(thrown).toMatchObject({ permanent: true });
      expect((thrown as Error).cause).toBe(cause);
    });
  }

  it('any other auth.test failure is still not fatal', async () => {
    const adapter = new SlackAdapter(config({ mode: { http: true, socket: false } }));
    withAuthTest(adapter, () => Promise.reject(platformError('missing_scope')));
    await expect(adapter.start()).resolves.toBeUndefined();
    withAuthTest(adapter, () => Promise.reject(new Error('ECONNRESET')));
    await expect(adapter.start()).resolves.toBeUndefined();
  });

  it('a Socket Mode start refused for the app token is permanent; a network one is not', async () => {
    const adapter = new SlackAdapter(config());
    withAuthTest(adapter, () => Promise.resolve({ ok: true, user_id: 'UBOT', user: 'bot' }));
    const app = (adapter as unknown as { app: { start: () => Promise<unknown> } }).app;
    app.start = () => Promise.reject(platformError('invalid_auth'));
    expect(await startError(adapter)).toMatchObject({ permanent: true });

    const network = new Error('getaddrinfo ENOTFOUND slack.com');
    app.start = () => Promise.reject(network);
    expect(await startError(adapter)).toBe(network);
  });

  // V2-RT-1 — the gateway retries a transient start failure on the SAME
  // instance. Bolt runs every matching listener, so registering again would
  // dispatch each message, `/ethos` command and button click twice.
  it('registers each listener once across a retried start', async () => {
    const adapter = new SlackAdapter(config());
    withAuthTest(adapter, () => Promise.resolve({ ok: true, user_id: 'UBOT', user: 'bot' }));
    const app = (adapter as unknown as { app: Record<string, unknown> }).app;
    const spies = ['event', 'message', 'command', 'action', 'view'].map((m) =>
      vi.spyOn(app as Record<string, () => unknown>, m as never),
    );
    const registrations = () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    app.start = vi
      .fn()
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND slack.com'))
      .mockResolvedValue(undefined);

    expect(await startError(adapter)).toBeInstanceOf(Error);
    const afterFirst = registrations();
    expect(afterFirst).toBeGreaterThan(0);
    await expect(adapter.start()).resolves.toBeUndefined();
    expect(app.start).toHaveBeenCalledTimes(2);
    expect(registrations()).toBe(afterFirst);
  });
});
