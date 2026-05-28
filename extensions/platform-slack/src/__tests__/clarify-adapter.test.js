// Adapter-level tests for the clarify wiring: the Bolt block_actions /
// view_submission registrations, payload normalization, and `fromHome`
// detection for App Home clicks (which Slack delivers as block_actions
// with no `body.channel`/`body.message` — see codex P4 review HIGH 1).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
  CLARIFY_MODAL_CALLBACK_ID,
} from '../blocks/clarify';

const postMessage = vi.fn();
const update = vi.fn();
const viewsOpen = vi.fn();
const authTest = vi.fn().mockResolvedValue({ user_id: 'UBOT' });
const actionHandlers = new Map();
const viewHandlers = new Map();
vi.mock('@slack/bolt', () => {
  class App {
    client = {
      chat: { postMessage, update },
      auth: { test: authTest },
      views: { open: viewsOpen },
    };
    async start() {}
    async stop() {}
    command() {}
    event() {}
    message() {}
    action(id, handler) {
      actionHandlers.set(id, handler);
    }
    view(id, handler) {
      viewHandlers.set(id, handler);
    }
  }
  return { default: { App } };
});
const { SlackAdapter } = await import('../adapter');
function makeAdapter() {
  return new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'bot-1',
  });
}
beforeEach(() => {
  postMessage.mockReset().mockResolvedValue({ ts: '1700000000.9' });
  update.mockReset().mockResolvedValue({ ok: true });
  viewsOpen.mockReset().mockResolvedValue({ ok: true });
  actionHandlers.clear();
  viewHandlers.clear();
});
describe('SlackAdapter — clarify block_actions normalization', () => {
  it('marks fromHome=false for a channel-message click', async () => {
    const adapter = makeAdapter();
    const events = [];
    adapter.onClarifyAction((e) => events.push(e));
    await adapter.start();
    const handler = actionHandlers.get(CLARIFY_CHOICE_ACTION_ID);
    if (!handler) throw new Error('choice handler not registered');
    await handler({
      ack: async () => {},
      body: {
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts: 'ts-1' },
        trigger_id: 'TRG',
      },
      action: { action_id: CLARIFY_CHOICE_ACTION_ID, value: 'r1:0' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'choice',
      requestId: 'r1',
      choiceIndex: 0,
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
  });
  it('marks fromHome=true for an App Home click (no channel, no message)', async () => {
    const adapter = makeAdapter();
    const events = [];
    adapter.onClarifyAction((e) => events.push(e));
    await adapter.start();
    const handler = actionHandlers.get(CLARIFY_CHOICE_ACTION_ID);
    if (!handler) throw new Error('choice handler not registered');
    await handler({
      ack: async () => {},
      body: {
        user: { id: 'U1' },
        view: { type: 'home' },
        // no channel, no message — this is what Slack actually sends
        trigger_id: 'TRG',
      },
      action: { action_id: CLARIFY_CHOICE_ACTION_ID, value: 'r1:0' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'choice',
      requestId: 'r1',
      channelId: '',
      messageTs: '',
      fromHome: true,
    });
  });
  it('routes cancel and answer (open-modal) through the same handler', async () => {
    const adapter = makeAdapter();
    const events = [];
    adapter.onClarifyAction((e) => events.push(e));
    await adapter.start();
    const cancelHandler = actionHandlers.get(CLARIFY_CANCEL_ACTION_ID);
    const answerHandler = actionHandlers.get(CLARIFY_ANSWER_ACTION_ID);
    expect(cancelHandler).toBeDefined();
    expect(answerHandler).toBeDefined();
    await cancelHandler?.({
      ack: async () => {},
      body: {
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts: 'ts-1' },
        trigger_id: 'TRG',
      },
      action: { action_id: CLARIFY_CANCEL_ACTION_ID, value: 'r1' },
    });
    await answerHandler?.({
      ack: async () => {},
      body: {
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts: 'ts-1' },
        trigger_id: 'TRG-go',
      },
      action: { action_id: CLARIFY_ANSWER_ACTION_ID, value: 'r1' },
    });
    expect(events.map((e) => e.kind)).toEqual(['cancel', 'open-modal']);
  });
});
describe('SlackAdapter — clarify view_submission', () => {
  it('parses the submission and forwards the answer', async () => {
    const adapter = makeAdapter();
    const events = [];
    adapter.onClarifyModalSubmit((e) => events.push(e));
    await adapter.start();
    const handler = viewHandlers.get(CLARIFY_MODAL_CALLBACK_ID);
    if (!handler) throw new Error('view handler not registered');
    await handler({
      ack: async () => {},
      body: {
        user: { id: 'U7' },
        view: {
          callback_id: CLARIFY_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ requestId: 'r1' }),
          state: {
            values: {
              ethos_clarify_modal_input: {
                ethos_clarify_modal_value: { value: 'normalized 3NF' },
              },
            },
          },
        },
      },
    });
    expect(events).toEqual([{ requestId: 'r1', answer: 'normalized 3NF', userId: 'U7' }]);
  });
});
describe('SlackAdapter — postClarifyCard / updateClarifyCard / openClarifyModal', () => {
  it('postClarifyCard returns the message ts on success', async () => {
    const adapter = makeAdapter();
    const result = await adapter.postClarifyCard({ chatId: 'C1', blocks: [] });
    expect(result).toEqual({ messageTs: '1700000000.9' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1' }));
  });
  it('postClarifyCard reports the error on Slack failure', async () => {
    postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    const adapter = makeAdapter();
    const result = await adapter.postClarifyCard({ chatId: 'C1', blocks: [] });
    expect(result).toEqual({ error: 'channel_not_found' });
  });
  it('updateClarifyCard chat.updates the in-place card', async () => {
    const adapter = makeAdapter();
    await adapter.updateClarifyCard({ chatId: 'C1', messageTs: 'ts-1', blocks: [] });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: 'ts-1' }));
  });
  it('openClarifyModal calls views.open with the trigger id and view', async () => {
    const adapter = makeAdapter();
    await adapter.openClarifyModal({ triggerId: 'TRG', view: { type: 'modal' } });
    expect(viewsOpen).toHaveBeenCalledWith({
      trigger_id: 'TRG',
      view: { type: 'modal' },
    });
  });
});
