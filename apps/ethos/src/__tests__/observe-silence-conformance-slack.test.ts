// Observe-mode silence conformance, Slack half: every handler the Slack adapter
// registers must put nothing into an observed room. The cross-adapter table
// (message path) lives in observe-silence-conformance.test.ts; the shared
// recorder, mock and `startSlack` are in observe-silence-fixtures.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  type Mode,
  recordingClient,
  SLACK_CHANNEL,
  SLACK_INVOKER,
  SLACK_WEB_UI_BASE,
  slackCalls,
  slackHandlerReached,
  slackHandlers,
  startSlack,
} from './observe-silence-fixtures';

vi.mock('@slack/bolt', async () => (await import('./observe-silence-fixtures')).slackBoltMock());

const { SlackAdapter, loadSlackSdk } = await import(
  '../../../../extensions/platform-slack/src/index'
);
// The adapter reads its SDK (mocked above) through sdk.ts, as in production.
await loadSlackSdk();
// The modal driver has to build a payload `handleClarifyModalSubmission` will
// actually accept, and those ids are the adapter's, not this file's.
const { CLARIFY_MODAL_INPUT_ACTION_ID, CLARIFY_MODAL_INPUT_BLOCK_ID } = await import(
  '../../../../extensions/platform-slack/src/blocks/clarify'
);

// ---------------------------------------------------------------------------
// Slack — EVERY registered handler, not just the message path
// ---------------------------------------------------------------------------

// The table above drives exactly one shape per adapter: a plain unaddressed
// group message. That is the shape the four historical receipt-reaction bugs
// had, and it is the shape this file was built around — which is precisely why
// three Slack handlers that put content into an observed channel survived it:
//
//   `member_joined_channel` posted a public greeting on every invite, with the
//   mode interpolated as display text and never consulted as a gate;
//   `/ethos ask` submitted a full agent turn (answer posted by the gateway)
//   plus an `in_channel` acknowledgement; and `link_shared` called
//   `chat.unfurl` with no mode check at all.
//
// None of them is on the message path. So this sweep does not drive a shape —
// it drives the ADAPTER'S OWN REGISTRATION LIST. `MockApp` records every
// `message`/`event`/`command`/`action`/`view`/`shortcut` call the adapter makes
// under a stable key, so `slackHandlers.keys()` after `start()` is the real
// roster, discovered rather than remembered.
//
// A driver per key supplies the payload that key's handler expects, because no
// generic payload can stand in for a `view_submission` and a `link_shared` at
// once. `enrollment` below closes that gap: the roster and the driver table
// must match exactly, so a NEW registration fails this file by name until
// someone drives it and proves it silent. That is the part that stops
// recurrence — the next handler is covered by the enumeration, and the only
// way past the gate is to write its case.

/** Bolt args are shaped per registration kind; a driver builds one payload. */
type HandlerDriver = (handler: (args: unknown) => Promise<void>) => Promise<void>;

/** A Bolt `client` that records into the same log the adapter's own does. */
function boltClient(): unknown {
  return recordingClient(slackCalls);
}

/** Records the ack Slack requires on every interactive payload. */
async function ack(): Promise<void> {
  slackCalls.push('ack');
}

/** Records the slash-command reply BY VISIBILITY — `in_channel` is a post. */
async function respond(args: { response_type?: string }): Promise<void> {
  slackCalls.push(`respond(${args.response_type ?? 'unknown'})`);
}

/** A `block_actions` payload — the shape both the approval and clarify
 *  handlers narrow. */
function blockActions(actionId: string, value: string): unknown {
  return {
    ack,
    body: {
      user: { id: SLACK_INVOKER },
      channel: { id: SLACK_CHANNEL },
      message: { ts: '1699000000.000100' },
      trigger_id: 'T1',
    },
    action: { action_id: actionId, value },
  };
}

/**
 * `value` is per action id and is NOT interchangeable: `handleClarifyAction`
 * (`extensions/platform-slack/src/interactions/clarify.ts`) parses a choice
 * click as `<requestId>:<index>` and returns early on anything else. A
 * one-size `'v1'` therefore reached the choice handler's first `return`, not
 * its callback — the same vacuity the `slackHandlerReached` assertion exists
 * to catch, one layer further in.
 */
const buttonDriver =
  (actionId: string, value = 'req-1'): HandlerDriver =>
  async (handler) => {
    await handler(blockActions(actionId, value));
  };

const SLACK_HANDLER_DRIVERS: Record<string, HandlerDriver> = {
  message: async (handler) => {
    await handler({
      message: {
        ts: '1699000000.000100',
        text: 'concrete pour slipped to thursday',
        user: SLACK_INVOKER,
        channel: SLACK_CHANNEL,
        channel_type: 'channel',
      },
    });
  },
  'event:app_mention': async (handler) => {
    await handler({
      event: {
        channel: SLACK_CHANNEL,
        user: SLACK_INVOKER,
        text: '<@UBOT> are we on track?',
        ts: '1699000000.000200',
      },
      client: boltClient(),
    });
  },
  // The bot itself being invited — the greeting path.
  'event:member_joined_channel': async (handler) => {
    await handler({
      event: { user: 'UBOT', channel: SLACK_CHANNEL },
      client: boltClient(),
    });
  },
  // An Ethos link pasted into the room — the unfurl path.
  'event:link_shared': async (handler) => {
    await handler({
      event: {
        channel: SLACK_CHANNEL,
        message_ts: '1699000000.000300',
        links: [{ url: `${SLACK_WEB_UI_BASE}/sessions/s-1` }],
      },
      client: boltClient(),
    });
  },
  // The App Home tab. Per-user by construction, so its `views.publish` is
  // allowlisted below — but it is driven, so a handler that started posting
  // into a CHANNEL from here would be caught.
  'event:app_home_opened': async (handler) => {
    await handler({ event: { user: SLACK_INVOKER, tab: 'home' }, client: boltClient() });
  },
  // `/ethos ask` specifically: the subcommand that used to submit a turn whose
  // answer the gateway posts into the room, plus an `in_channel` ack.
  'command:/ethos': async (handler) => {
    await handler({
      command: {
        command: '/ethos',
        text: 'ask what is the pour date',
        channel_id: SLACK_CHANNEL,
        user_id: SLACK_INVOKER,
        trigger_id: 'T1',
      },
      ack,
      respond,
    });
  },
  'action:ethos_approval_allow': buttonDriver('ethos_approval_allow'),
  'action:ethos_approval_deny': buttonDriver('ethos_approval_deny'),
  // Opens the deny-with-note modal (`views.open`, visible only to the clicker).
  'action:ethos_approval_deny_note': buttonDriver('ethos_approval_deny_note'),
  'action:ethos_clarify_choice': buttonDriver('ethos_clarify_choice', 'req-1:0'),
  'action:ethos_clarify_cancel': buttonDriver('ethos_clarify_cancel'),
  'action:ethos_clarify_answer': buttonDriver('ethos_clarify_answer'),
  // Digest / brief buttons (`init:<verb>:<target>`): one RegExp registration.
  'action:/^init:/': buttonDriver('init:adopt:EXP-0001'),
  'action:home:refresh': async (handler) => {
    await handler({ ack, body: { user: { id: SLACK_INVOKER } }, client: boltClient() });
  },
  // `private_metadata` and the input value are both load-bearing:
  // `handleClarifyModalSubmission` returns early on unparseable metadata, on a
  // missing input block, and on an empty answer. The previous payload tripped
  // all three, so this case asserted silence against a function that had
  // returned three lines in.
  // `private_metadata` must carry the approval's coordinates or
  // `handleApprovalNoteSubmission` returns before reaching the decision handler.
  'view:ethos_approval_note': async (handler) => {
    await handler({
      ack,
      body: {
        user: { id: SLACK_INVOKER },
        view: {
          callback_id: 'ethos_approval_note',
          private_metadata: JSON.stringify({
            approvalId: 'req-1',
            channelId: SLACK_CHANNEL,
            messageTs: '1699000000.000100',
          }),
          state: {
            values: {
              ethos_approval_note_block: { ethos_approval_note_input: { value: 'use staging' } },
            },
          },
        },
      },
    });
  },
  'view:ethos_clarify_modal': async (handler) => {
    await handler({
      ack,
      body: {
        user: { id: SLACK_INVOKER },
        view: {
          callback_id: 'ethos_clarify_modal',
          private_metadata: JSON.stringify({ requestId: 'req-1' }),
          state: {
            values: {
              [CLARIFY_MODAL_INPUT_BLOCK_ID]: {
                [CLARIFY_MODAL_INPUT_ACTION_ID]: { value: 'thursday' },
              },
            },
          },
        },
      },
    });
  },
};

/**
 * The registrations whose handler body only runs once an injected handler is
 * wired — every one of them `await ack()`s and then `if (!handler) return;`.
 *
 * They have no answering-mode control (the list at the bottom of this file):
 * an approval or clarify click legitimately puts nothing in the ROOM under any
 * mode — the response goes back through the coordinator — so there is no
 * "still speaks when the mode says to answer" case to pair them with. That is
 * precisely why they need this instead: without it, `[] === []` is all they
 * assert, and it would keep passing against a handler that was never entered.
 */
const SLACK_HANDLERS_NEEDING_REACH: ReadonlySet<string> = new Set([
  'action:ethos_approval_allow',
  'action:ethos_approval_deny',
  'view:ethos_approval_note',
  'action:ethos_clarify_choice',
  'action:ethos_clarify_cancel',
  'action:ethos_clarify_answer',
  'action:/^init:/',
  'view:ethos_clarify_modal',
]);

/**
 * Calls the ROOM cannot see. Everything else is content in a channel.
 *
 * Each entry is here on the same test the table above applies: could a person
 * sitting in the observed channel tell it happened? A Web API read and a
 * protocol ack produce nothing; an `ephemeral` reply and a Home-tab publish
 * render for one viewer, which is exactly how the operator still learns what
 * silenced the room. `respond(in_channel)` is deliberately NOT here — it is a
 * public post, and it is half of the `/ethos ask` bug.
 */
const SLACK_INVISIBLE: ReadonlySet<string> = new Set([
  'ack',
  'respond(ephemeral)',
  'users.info',
  'views.publish',
  // A modal opens for the clicker alone (the deny-with-note button).
  'views.open',
]);

/** Drive one registered handler in `mode`; report what the room could see, and
 *  whether the handler body ran far enough to reach an injected handler. */
async function sweepSlackHandler(
  key: string,
  mode: Mode,
): Promise<{ visible: string[]; reached: string[] }> {
  await startSlack(SlackAdapter, mode);
  const handler = slackHandlers.get(key);
  if (!handler) throw new Error(`adapter registered no handler for ${key}`);
  const driver = SLACK_HANDLER_DRIVERS[key];
  if (!driver) throw new Error(`no driver for registered handler ${key}`);
  slackCalls.length = 0;
  slackHandlerReached.length = 0;
  await driver(handler);
  // Slash and unfurl work is awaited inside the handlers; the receipt reaction
  // and file enrichment are fired without awaiting, so let the microtask queue
  // drain before reading the log or an `all`-mode control would race.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    visible: slackCalls.filter((c) => !SLACK_INVISIBLE.has(c)),
    reached: [...slackHandlerReached],
  };
}

/** The roster, as the adapter itself registered it. */
async function registeredSlackHandlers(): Promise<string[]> {
  await startSlack(SlackAdapter, 'observe');
  return [...slackHandlers.keys()].sort();
}

describe('platform-slack — every registered handler is silent in observe mode', () => {
  it('drives every handler the adapter registers, and no phantom ones', async () => {
    // Failing here means the Slack adapter registered a handler this file does
    // not drive — or that a driver outlived its registration. Add the key to
    // SLACK_HANDLER_DRIVERS with the payload its handler expects; do NOT add an
    // exemption, because the three bugs this sweep exists to catch were all in
    // handlers that were already registered and simply never invoked here.
    expect(await registeredSlackHandlers()).toEqual(Object.keys(SLACK_HANDLER_DRIVERS).sort());
  });

  it('names no reach-check for a handler it does not drive', () => {
    // `SLACK_HANDLERS_NEEDING_REACH` is a hand-written set, so it can rot the
    // other way: a key removed from the driver table would leave a reach-check
    // for a registration that no longer exists, and `it.each` over it would
    // fail confusingly inside `sweepSlackHandler` instead of here.
    for (const key of SLACK_HANDLERS_NEEDING_REACH) {
      expect(Object.keys(SLACK_HANDLER_DRIVERS)).toContain(key);
    }
  });

  it.each(Object.keys(SLACK_HANDLER_DRIVERS))(
    '%s puts nothing into an observed room',
    async (key) => {
      expect((await sweepSlackHandler(key, 'observe')).visible).toEqual([]);
    },
  );

  // Non-vacuity for the six registrations that have no answering-mode control.
  // Each one `await ack()`s and then `if (!handler) return;`, so before the
  // injected handlers were wired in `startSlack` these cases asserted `[]`
  // against a body that had already returned — and a `chat.update` added
  // downstream of `handleClarifyAction` would have kept the sweep green.
  it.each([...SLACK_HANDLERS_NEEDING_REACH])(
    '%s actually reaches its injected handler, so its silence means something',
    async (key) => {
      expect((await sweepSlackHandler(key, 'observe')).reached).toHaveLength(1);
    },
  );

  // The control. Without it the sweep above would pass just as well against
  // handlers that were never invoked, payloads that never matched, and an
  // adapter that answers nothing — proving no silence at all. These three are
  // exactly the handlers that were putting content into observed rooms, so
  // under an answering mode each one must still be seen doing it.
  // Sequential, never `Promise.all`: `startSlack` resets the module-global
  // handler map and call log, so concurrent sweeps read each other's calls —
  // which is itself a way this control can pass while proving nothing.
  it.each(['event:member_joined_channel', 'command:/ethos', 'event:link_shared'])(
    '%s still puts content into an answering room',
    async (key) => {
      expect((await sweepSlackHandler(key, 'all')).visible).not.toEqual([]);
    },
  );
});
