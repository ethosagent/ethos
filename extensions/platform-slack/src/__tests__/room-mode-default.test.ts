// Plan channel-prompts L12: the room config's default reply mode sits between a
// runtime `ChannelOverrideStore` override (above) and the platform default
// (below). Pins the precedence in Slack's triage and the diagnostic source.

import type { InboundMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type EnvelopeMeta, registerMessageEvents } from '../events/messages';
import {
  type RawSlackMention,
  type RawSlackMessage,
  resolveChannelModeSource,
  type TriageContext,
  triageMention,
  triageMessage,
} from '../routing/triage';

const channelPost: RawSlackMessage = {
  channel: 'C1',
  user: 'U1',
  text: 'hello room',
  ts: '111.222',
  channel_type: 'channel',
};

const mention: RawSlackMention = { channel: 'C1', user: 'U1', text: '<@B> hi', ts: '1.2' };

const override = (mode: string) =>
  ({ get: () => ({ mode, updatedAt: 1 }) }) as unknown as TriageContext['channelOverrides'];

const ctx = (extra: Partial<TriageContext> = {}): TriageContext => ({
  botKey: 'bot-a',
  defaultChannelMode: 'mention_only',
  ...extra,
});

describe('slack room mode default (L12)', () => {
  it('uses the room mode when there is no runtime override', async () => {
    const seen: unknown[] = [];
    const result = await triageMessage(
      channelPost,
      ctx({
        roomModeDefault: (i) => {
          seen.push(i);
          return 'all';
        },
      }),
    );
    expect(result.effectiveMode).toBe('all');
    expect(result.modeSource).toBe('room');
    expect(result.envelope?.recordOnly).toBe(false);
    expect(seen).toEqual([{ chatId: 'C1', isDm: false }]);
  });

  it('passes the thread id and the DM flag to the room lookup', async () => {
    const seen: unknown[] = [];
    await triageMessage(
      { ...channelPost, thread_ts: '99.1' },
      ctx({
        roomModeDefault: (i) => {
          seen.push(i);
          return undefined;
        },
      }),
    );
    await triageMessage(
      { ...channelPost, channel: 'D1', channel_type: 'im' },
      ctx({
        roomModeDefault: (i) => {
          seen.push(i);
          return undefined;
        },
      }),
    );
    expect(seen).toEqual([
      { chatId: 'C1', threadId: '99.1', isDm: false },
      { chatId: 'D1', isDm: true },
    ]);
  });

  it('a runtime override beats the room mode', async () => {
    const result = await triageMessage(
      channelPost,
      ctx({ channelOverrides: override('observe'), roomModeDefault: () => 'all' }),
    );
    expect(result.effectiveMode).toBe('observe');
    expect(result.modeSource).toBe('runtime');
    expect(result.envelope?.recordOnly).toBe(true);
  });

  it('falls to the platform default when the room has no mode', async () => {
    const result = await triageMessage(
      channelPost,
      ctx({
        defaultChannelMode: 'observe',
        defaultChannelModeConfigured: true,
        roomModeDefault: () => undefined,
      }),
    );
    expect(result.effectiveMode).toBe('observe');
    expect(result.modeSource).toBe('platform');
  });

  it('reports `default` when nothing configured the mode', async () => {
    const result = await triageMessage(channelPost, ctx({ roomModeDefault: () => undefined }));
    expect(result.modeSource).toBe('default');
    expect(result.drop).toBe('channel_mode');
  });

  it('an unreadable room mode fails closed: neither answered nor recorded', async () => {
    const result = await triageMessage(channelPost, ctx({ roomModeDefault: () => 'regex_match' }));
    expect(result.effectiveMode).toBe('regex_match');
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('channel_mode');
    const m = await triageMention(mention, ctx({ roomModeDefault: () => 'regex_match' }));
    expect(m.envelope).toBeUndefined();
  });

  it('a room `observe` records a mention without answering it', async () => {
    const result = await triageMention(mention, ctx({ roomModeDefault: () => 'observe' }));
    expect(result.envelope?.recordOnly).toBe(true);
    expect(result.modeSource).toBe('room');
  });

  it('resolveChannelModeSource defaults the scope to a non-DM', () => {
    expect(
      resolveChannelModeSource('C9', ctx({ roomModeDefault: (i) => (i.isDm ? 'all' : 'observe') })),
    ).toEqual({ mode: 'observe', source: 'room' });
  });
});

describe('slack channelModeSource stamp meta (L12)', () => {
  async function run(triage: TriageContext): Promise<EnvelopeMeta | undefined> {
    let handler: ((args: unknown) => Promise<void>) | undefined;
    const app = {
      message: (fn: (args: unknown) => Promise<void>) => {
        handler = fn;
      },
      event: () => {},
      client: {},
    };
    const metas: Array<EnvelopeMeta | undefined> = [];
    registerMessageEvents(app as never, triage, {
      onEnvelope: (_m: InboundMessage, meta?: EnvelopeMeta) => metas.push(meta),
    });
    await handler?.({ message: { ...channelPost, text: 'hello' } });
    expect(metas).toHaveLength(1);
    return metas[0];
  }

  it('carries mode and source when room policies configure the platform', async () => {
    const meta = await run(ctx({ defaultChannelMode: 'all', roomModeDefault: () => 'all' }));
    expect(meta).toEqual({ effectiveMode: 'all', modeSource: 'room' });
  });

  it('carries nothing without room policies or fetch_metadata', async () => {
    expect(await run(ctx({ defaultChannelMode: 'all' }))).toBeUndefined();
  });
});
