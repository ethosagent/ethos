// Pure tests for the clarify interaction handlers.
import { describe, expect, it, vi } from 'vitest';
import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
  CLARIFY_MODAL_CALLBACK_ID,
  CLARIFY_MODAL_INPUT_ACTION_ID,
  CLARIFY_MODAL_INPUT_BLOCK_ID,
} from '../blocks/clarify';
import { handleClarifyAction, handleClarifyModalSubmission } from '../interactions/clarify';

function payload(overrides = {}) {
  return {
    actionId: CLARIFY_CHOICE_ACTION_ID,
    value: 'r1:0',
    userId: 'U1',
    channelId: 'C1',
    messageTs: 'ts-1',
    triggerId: 'trigger-1',
    fromHome: false,
    ...overrides,
  };
}
describe('handleClarifyAction', () => {
  it('routes a valid choice click', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(payload({ value: 'r1:2' }), { onAction });
    expect(onAction).toHaveBeenCalledWith({
      kind: 'choice',
      requestId: 'r1',
      choiceIndex: 2,
      userId: 'U1',
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
  });
  it('routes a cancel click', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(payload({ actionId: CLARIFY_CANCEL_ACTION_ID, value: 'r1' }), {
      onAction,
    });
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cancel', requestId: 'r1' }),
    );
  });
  it('routes an open-modal click and forwards the trigger id', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(
      payload({ actionId: CLARIFY_ANSWER_ACTION_ID, value: 'r1', triggerId: 'TRG' }),
      { onAction },
    );
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'open-modal', requestId: 'r1', triggerId: 'TRG' }),
    );
  });
  it('drops anonymous (no userId) clicks', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(payload({ userId: '' }), { onAction });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('drops malformed choice value', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(payload({ value: 'no-colon' }), { onAction });
    await handleClarifyAction(payload({ value: 'r1:notanumber' }), { onAction });
    await handleClarifyAction(payload({ value: ':5' }), { onAction });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('drops open-modal click with no trigger id (Slack would 4xx anyway)', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(
      payload({ actionId: CLARIFY_ANSWER_ACTION_ID, value: 'r1', triggerId: '' }),
      { onAction },
    );
    expect(onAction).not.toHaveBeenCalled();
  });
  it('ignores unknown action_ids', async () => {
    const onAction = vi.fn();
    await handleClarifyAction(payload({ actionId: 'something_else' }), { onAction });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('swallows callback errors so a stale row never crashes Bolt', async () => {
    const onAction = vi.fn().mockRejectedValue(new Error('stale'));
    await expect(handleClarifyAction(payload(), { onAction })).resolves.toBeUndefined();
  });
});
describe('handleClarifyModalSubmission', () => {
  it('parses requestId from private_metadata and reads the input value', async () => {
    const onSubmit = vi.fn();
    await handleClarifyModalSubmission(
      {
        callbackId: CLARIFY_MODAL_CALLBACK_ID,
        privateMetadata: JSON.stringify({ requestId: 'r1' }),
        userId: 'U1',
        values: {
          [CLARIFY_MODAL_INPUT_BLOCK_ID]: {
            [CLARIFY_MODAL_INPUT_ACTION_ID]: { value: '  the answer  ' },
          },
        },
      },
      { onSubmit },
    );
    expect(onSubmit).toHaveBeenCalledWith({ requestId: 'r1', answer: 'the answer', userId: 'U1' });
  });
  it('drops empty answer', async () => {
    const onSubmit = vi.fn();
    await handleClarifyModalSubmission(
      {
        callbackId: CLARIFY_MODAL_CALLBACK_ID,
        privateMetadata: JSON.stringify({ requestId: 'r1' }),
        userId: 'U1',
        values: {
          [CLARIFY_MODAL_INPUT_BLOCK_ID]: {
            [CLARIFY_MODAL_INPUT_ACTION_ID]: { value: '   ' },
          },
        },
      },
      { onSubmit },
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('drops payloads with the wrong callback_id', async () => {
    const onSubmit = vi.fn();
    await handleClarifyModalSubmission(
      {
        callbackId: 'something-else',
        privateMetadata: JSON.stringify({ requestId: 'r1' }),
        userId: 'U1',
        values: {},
      },
      { onSubmit },
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('drops payloads with bad private_metadata', async () => {
    const onSubmit = vi.fn();
    await handleClarifyModalSubmission(
      {
        callbackId: CLARIFY_MODAL_CALLBACK_ID,
        privateMetadata: '{not json',
        userId: 'U1',
        values: {
          [CLARIFY_MODAL_INPUT_BLOCK_ID]: {
            [CLARIFY_MODAL_INPUT_ACTION_ID]: { value: 'a' },
          },
        },
      },
      { onSubmit },
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
