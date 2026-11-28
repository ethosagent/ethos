import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitiativeActionEvent } from '../interactions/initiative';
import { loadSlackSdk } from '../sdk';

beforeAll(async () => {
  await loadSlackSdk();
});

// Same mock shape as approval-adapter.test.ts: the App records `action` registrations so the test
// can fire them. `init:` buttons register one RegExp handler.
const postEphemeral = vi.fn();
const actionHandlers: Array<[string | RegExp, (args: unknown) => Promise<void>]> = [];

vi.mock('@slack/bolt', () => {
  class App {
    client = {
      chat: { postMessage: vi.fn(), update: vi.fn(), postEphemeral },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
      views: { open: vi.fn() },
    };
    async start() {}
    async stop() {}
    command() {}
    event() {}
    message() {}
    view() {}
    action(id: string | RegExp, handler: (args: unknown) => Promise<void>) {
      actionHandlers.push([id, handler]);
    }
  }
  return { default: { App } };
});

const { SlackAdapter } = await import('../adapter');

beforeEach(() => {
  actionHandlers.length = 0;
  postEphemeral.mockReset().mockResolvedValue({ ok: true });
});

function adapter() {
  return new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'bot-1',
  });
}

const fire = async (actionId: string, user = 'U1') => {
  const entry = actionHandlers.find(([id]) => id instanceof RegExp && id.test(actionId));
  await entry?.[1]({
    ack: async () => {},
    body: { user: { id: user }, channel: { id: 'C1' }, message: { ts: '1.2' } },
    action: { action_id: actionId },
  });
};

describe('init: button routing', () => {
  it('routes a well-formed tap with the user, and replies ephemerally to the tapper only', async () => {
    const a = adapter();
    await a.start();
    const taps: InitiativeActionEvent[] = [];
    a.onInitiativeAction(async (e) => {
      taps.push(e);
      await e.reply('done');
    });
    await fire('init:adopt:EXP-0003', 'UOWNER');
    expect(taps).toHaveLength(1);
    expect(taps[0]).toMatchObject({
      verb: 'adopt',
      target: 'EXP-0003',
      userId: 'UOWNER',
      channelId: 'C1',
    });
    expect(postEphemeral).toHaveBeenCalledWith({ channel: 'C1', user: 'UOWNER', text: 'done' });
  });

  it('drops a malformed action id and does nothing without a handler', async () => {
    const a = adapter();
    await a.start();
    const taps: InitiativeActionEvent[] = [];
    await fire('init:adopt:EXP-0003'); // no handler yet
    a.onInitiativeAction((e) => void taps.push(e));
    await fire('init:adopt:some free text');
    await fire('init:nuke:EXP-1');
    expect(taps).toEqual([]);
  });
});
