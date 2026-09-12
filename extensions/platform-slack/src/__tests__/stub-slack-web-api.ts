import boltPkg from '@slack/bolt';
import { beforeEach, vi } from 'vitest';

const { App, HTTPReceiver } = boltPkg;

/**
 * Keep a REAL Bolt `App` off the network.
 *
 * Given a bot token, Bolt's `App` constructor calls `auth.test` immediately
 * (`singleAuthorization` in `@slack/bolt/dist/App.js`, because
 * `tokenVerificationEnabled` defaults to true) and nothing awaits the promise.
 * With a fake token that is a real request to slack.com, answered
 * `invalid_auth` a few hundred milliseconds later — an unhandled rejection
 * that lands in whatever the worker is running by then, and an unhandled
 * error fails a vitest run. Replacing `adapter.client` after construction
 * does not help: the call has already left.
 *
 * The stub goes on the WebClient's single dispatch method, on its prototype:
 * `bindApiCall` binds `apiCall` when a client is constructed, so a
 * prototype-level stub is captured by every client built after it. The
 * prototype is reached through a throwaway `App` built with an explicit
 * `authorize` and no token — the one construction shape that does not fire
 * the eager call. Same technique as `webhook-mode.test.ts`.
 *
 * Installed per test, not once per file, because `vi.restoreAllMocks()` in a
 * file's `afterEach` would otherwise remove it after the first test.
 *
 * Call at the top level of any test file that constructs a `SlackAdapter`
 * without mocking `@slack/bolt`.
 */
export function stubSlackWebApi(): void {
  const probeApp = new App({
    receiver: new HTTPReceiver({ signingSecret: 'probe' }),
    authorize: async () => ({ botToken: 'xoxb-fake', botUserId: 'UBOT', botId: 'BBOT' }),
  });
  const webClientProto = Object.getPrototypeOf(probeApp.client) as {
    apiCall: (...args: unknown[]) => Promise<unknown>;
  };
  beforeEach(() => {
    vi.spyOn(webClientProto, 'apiCall').mockResolvedValue({
      ok: true,
      user_id: 'UBOT',
      bot_id: 'BBOT',
    });
  });
}
