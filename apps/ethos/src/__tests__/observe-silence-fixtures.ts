// Shared fixtures for the observe-silence conformance tests (the table in
// observe-silence-conformance.test.ts and the Slack handler sweep in
// observe-silence-conformance-slack.test.ts). Not a test file: the root vitest
// glob is `*.test.ts`. Module state is per test file, so each file gets its own
// call log and handler map.

import type { InboundMessage } from '@ethosagent/types';

type SlackAdapterCtor =
  typeof import('../../../../extensions/platform-slack/src/index').SlackAdapter;

// ---------------------------------------------------------------------------
// Recording platform client
// ---------------------------------------------------------------------------

/** Dotted names of the platform calls an adapter made, in order. */
export type CallLog = string[];

/**
 * A platform client that records EVERY method call by dotted name and resolves
 * to a canned result.
 *
 * The point is the open set: `reactions.add`, `sendMessage`, `setMessageReaction`
 * and anything an adapter starts calling tomorrow are all recorded the same
 * way, without this file having to know the method exists. A hand-listed spy
 * per method only catches the noise we already thought of.
 */
export function recordingClient(
  log: CallLog,
  results: Record<string, unknown> = {},
  path = '',
): unknown {
  return new Proxy(() => {}, {
    get(_target, prop) {
      // `then` must stay absent or awaiting a returned promise recurses.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return recordingClient(log, results, path ? `${path}.${prop}` : prop);
    },
    apply() {
      log.push(path);
      return Promise.resolve(results[path] ?? {});
    },
  });
}

/** The two modes the conformance tests drive: silent, and the answering control. */
export type Mode = 'observe' | 'all';

export const SLACK_CHANNEL = 'C_SITE_7';
export const SLACK_INVOKER = 'U_STRANGER';

export const slackCalls: CallLog = [];
/** Which of the adapter's injected handlers a driven registration actually
 *  reached. See `startSlack` for why this exists. */
export const slackHandlerReached: string[] = [];
export const slackHandlers = new Map<string, (args: unknown) => Promise<void>>();
export const SLACK_WEB_UI_BASE = 'https://ethos.example.com';

/** Factory for `vi.mock('@slack/bolt', ...)` in each test file. */
export function slackBoltMock() {
  // Every registration is captured under a stable key, not just the two the
  // message path uses. The keys ARE the adapter's own registration list, which
  // is what lets the sweep at the bottom of this file enumerate handlers
  // instead of trusting a hand-written roster.
  class MockApp {
    client = recordingClient(slackCalls, { 'auth.test': { user_id: 'UBOT', user: 'ethos' } });
    async start() {}
    async stop() {}
    message(fn: (args: unknown) => Promise<void>) {
      slackHandlers.set('message', fn);
    }
    event(name: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`event:${name}`, fn);
    }
    command(name: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`command:${name}`, fn);
    }
    view(id: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`view:${id}`, fn);
    }
    action(id: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`action:${id}`, fn);
    }
    shortcut(id: string, fn: (args: unknown) => Promise<void>) {
      slackHandlers.set(`shortcut:${id}`, fn);
    }
    error() {}
    use() {}
  }
  return { default: { App: MockApp } };
}

/**
 * Start a Slack adapter with EVERY optional dependency wired, so every handler
 * the adapter is capable of registering actually registers.
 *
 * `binding` gates `member_joined_channel`; `webUiBaseUrl` gates `link_shared`;
 * `sessionUnfurl` is what lets an unfurl resolve to a real card rather than
 * being skipped. A partially-wired adapter would register a smaller handler
 * set, and the sweep below would then be enumerating — and passing — a subset
 * of production.
 */
export async function startSlack(
  SlackAdapter: SlackAdapterCtor,
  mode: Mode,
): Promise<{ envelopes: InboundMessage[] }> {
  slackCalls.length = 0;
  slackHandlers.clear();

  const adapter = new SlackAdapter({
    botToken: 'xoxb-1',
    // Socket Mode is the default transport and the constructor refuses without it.
    appToken: 'xapp-1',
    botKey: 'prod-slack',
    defaultChannelMode: mode,
    binding: { type: 'personality', name: 'sitewatcher' },
    // `/ethos` is default-deny (authz.ts, CHS-001). Without an allowlisted
    // invoker the slash handler short-circuits on the refusal and never reaches
    // a subcommand, which would make this sweep's `command:/ethos` case pass
    // vacuously against the exact bug it is here to catch.
    allowedUsers: [SLACK_INVOKER],
    webUiBaseUrl: SLACK_WEB_UI_BASE,
    sessionUnfurl: {
      lookupSession: async (id: string) => ({
        id,
        personalityName: 'sitewatcher',
        lastActivity: new Date(0),
      }),
    },
  });
  const envelopes: InboundMessage[] = [];
  adapter.onMessage((m) => envelopes.push(m));
  // The interactive handlers all `await ack()` and then `if (!handler) return;`
  // (adapter.ts). Without these three the approval, clarify-button and
  // clarify-modal cases below drove a handler that returned before its body ran
  // and asserted `[] === []` against nothing — six cases that could not fail,
  // in a sweep whose value is that it enumerates. `slackHandlerReached` records
  // that the body got all the way through, and the assertion on it is what
  // stops the vacuity coming back.
  slackHandlerReached.length = 0;
  adapter.onApprovalDecision(() => {
    slackHandlerReached.push('approval-decision');
  });
  adapter.onClarifyAction(() => {
    slackHandlerReached.push('clarify-action');
  });
  adapter.onInitiativeAction(() => {
    slackHandlerReached.push('initiative-action');
  });
  adapter.onClarifyModalSubmit(() => {
    slackHandlerReached.push('clarify-modal-submit');
  });
  await adapter.start();
  // Everything above is startup. Only the handlers are on trial.
  slackCalls.length = 0;
  return { envelopes };
}
