import { ChannelOverrideStore } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { dispatch } from '../commands';
import { ChannelModeSchema } from '../config';
import { basePayload, ctxFor, memStorage } from './commands-fixtures';

describe('dispatch — channel', () => {
  it.each([
    ['', '/channel'],
    ['  ', '/channel'],
    ['show', '/channel show'],
    ['SHOW', '/channel show'],
  ])('forwards "%s" as %s through submitAgentTurn', async (rest, forwarded) => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const r = await dispatch(
      { ...basePayload, text: `channel ${rest}` },
      ctxFor({ submitAgentTurn: submit }),
    );
    expect(submit).toHaveBeenCalledWith({
      channel: 'C1',
      user: 'U1',
      text: forwarded,
      isDm: false,
    });
    expect(r.responseType).toBe('ephemeral');
  });

  it('rejects an unknown argument without submitting', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const r = await dispatch(
      { ...basePayload, text: 'channel nope' },
      ctxFor({ submitAgentTurn: submit }),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(r.text).toContain('Usage');
  });

  it('says submission is unavailable when no submitter is wired', async () => {
    const r = await dispatch({ ...basePayload, text: 'channel' }, ctxFor());
    expect(r.text).toContain('not configured');
  });

  it('is refused in an observe-mode room, like /ethos ask', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const r = await dispatch(
      { ...basePayload, text: 'channel' },
      ctxFor({ defaultChannelMode: 'observe', submitAgentTurn: submit }),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(r.text).toContain('observe');
  });
});

describe('dispatch — room default mode (plan channel-prompts L12)', () => {
  const roomObserve = (input: { chatId: string }) =>
    input.chatId === 'C1' ? 'observe' : undefined;

  it('channel-mode show reports the room default and its source', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'channel-mode show' },
      ctxFor({ roomModeDefault: roomObserve }),
    );
    expect(r.text).toContain('observe');
    expect(r.text).toContain('room config');
  });

  it('channel-mode show reports a configured platform default as such', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'channel-mode show' },
      ctxFor({ defaultChannelModeConfigured: true }),
    );
    expect(r.text).toContain('platform default');
  });

  it('a runtime override still beats the room default', async () => {
    const overrides = new ChannelOverrideStore(memStorage(), '/slack/bot-a', ChannelModeSchema);
    await overrides.set('C1', 'all');
    const r = await dispatch(
      { ...basePayload, text: 'channel-mode show' },
      ctxFor({ channelOverrides: overrides, roomModeDefault: roomObserve }),
    );
    expect(r.text).toContain('per-channel override');
  });

  it('/ethos ask is refused in a room whose room default is observe', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const r = await dispatch(
      { ...basePayload, text: 'ask hi' },
      ctxFor({ roomModeDefault: roomObserve, submitAgentTurn: submit }),
    );
    expect(r.responseType).toBe('ephemeral');
    expect(r.text).toContain('observe');
    expect(submit).not.toHaveBeenCalled();
  });

  it('/ethos channel is refused in a room whose room default is observe, like /ethos ask', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const r = await dispatch(
      { ...basePayload, text: 'channel' },
      ctxFor({ roomModeDefault: roomObserve, submitAgentTurn: submit }),
    );
    expect(r.responseType).toBe('ephemeral');
    expect(r.text).toContain('observe');
    expect(submit).not.toHaveBeenCalled();
  });

  it('/ethos ask in a DM ignores a room default (isDm reaches the resolver)', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const seen: boolean[] = [];
    await dispatch(
      { ...basePayload, channel_id: 'D1', text: 'ask hi' },
      ctxFor({
        roomModeDefault: (i) => {
          seen.push(i.isDm);
          return 'observe';
        },
        submitAgentTurn: submit,
      }),
    );
    expect(seen).toContain(true);
  });

  it('/ethos help shows the room default', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'help' },
      ctxFor({ roomModeDefault: roomObserve }),
    );
    expect(r.text).toContain('observe');
  });
});
