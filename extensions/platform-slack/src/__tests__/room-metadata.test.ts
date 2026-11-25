// Plan channel-prompts L7 — Slack fetches `conversations.info` (topic, purpose,
// name) only when `fetch_metadata` is on, caches it for 1 h per channel, and
// falls back quietly on `missing_scope`. `selfIdentity` is the `auth.test` bot.

import type { InboundMessage, Logger } from '@ethosagent/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';
import { createKeyedChain, createSlackRoomMetadata, ROOM_METADATA_TTL_MS } from '../room-metadata';
import { loadSlackSdk } from '../sdk';

beforeAll(async () => {
  await loadSlackSdk();
});

function logger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const l = {
    warns,
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    child: () => l,
  };
  return l as unknown as Logger & { warns: string[] };
}

type InfoChannel = { name?: string; topic?: { value?: string }; purpose?: { value?: string } };
const info = (channel: InfoChannel) => ({ channel });

describe('createSlackRoomMetadata', () => {
  it('reads topic, purpose and name, and serves the next call from the 1 h cache', async () => {
    const call = vi.fn(async () =>
      info({ name: 'deploys', topic: { value: ' freeze ' }, purpose: { value: 'ship it' } }),
    );
    let t = 1000;
    const get = createSlackRoomMetadata({ conversations: { info: call } }, logger(), () => t);
    const want = { topic: 'freeze', purpose: 'ship it', name: 'deploys' };
    expect(await get('C1')).toEqual(want);
    t += ROOM_METADATA_TTL_MS - 1;
    expect(await get('C1')).toEqual(want);
    expect(call).toHaveBeenCalledTimes(1);
    t += 2;
    await get('C1');
    expect(call).toHaveBeenCalledTimes(2);
    await get('C2');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('missing_scope logs once, returns undefined and does not retry within the hour', async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error('x'), { data: { error: 'missing_scope' } });
    });
    const log = logger();
    const get = createSlackRoomMetadata({ conversations: { info: call } }, log, () => 5);
    expect(await get('C1')).toBeUndefined();
    expect(await get('C1')).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain('channels:read');
  });

  it('empty topic and purpose give undefined', async () => {
    const get = createSlackRoomMetadata(
      {
        conversations: { info: async () => info({ topic: { value: '' }, purpose: { value: '' } }) },
      },
      logger(),
    );
    expect(await get('C1')).toBeUndefined();
  });
});

describe('cold cache', () => {
  it('shares one conversations.info call between concurrent messages', async () => {
    let release: () => void = () => {};
    const call = vi.fn(
      () =>
        new Promise<ReturnType<typeof info>>((resolve) => {
          release = () => resolve(info({ name: 'deploys' }));
        }),
    );
    const get = createSlackRoomMetadata({ conversations: { info: call } }, logger());
    const a = get('C1');
    const b = get('C1');
    release();
    expect(await a).toEqual({ name: 'deploys' });
    expect(await b).toEqual({ name: 'deploys' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a hanging conversations.info is waited for only waitMs, then the caller gets undefined', async () => {
    const call = vi.fn(() => new Promise<never>(() => {}));
    const get = createSlackRoomMetadata({ conversations: { info: call } }, logger(), Date.now, 20);
    const t0 = Date.now();
    expect(await get('C1')).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a late answer past the wait still fills the cache', async () => {
    let release: () => void = () => {};
    const call = vi.fn(
      () =>
        new Promise<ReturnType<typeof info>>((resolve) => {
          release = () => resolve(info({ name: 'late' }));
        }),
    );
    const get = createSlackRoomMetadata({ conversations: { info: call } }, logger(), Date.now, 10);
    expect(await get('C1')).toBeUndefined();
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(await get('C1')).toEqual({ name: 'late' });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('delivery order (createKeyedChain)', () => {
  it('two quick messages on a cold channel reach the handler in order, even when the first is slow', async () => {
    const chain = createKeyedChain();
    const seen: string[] = [];
    const slow = (ms: number, id: string) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      seen.push(id);
    };
    chain('C1', slow(40, 'first'));
    chain('C1', slow(1, 'second'));
    chain('C2', slow(1, 'other-channel'));
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toEqual(['other-channel', 'first', 'second']);
  });

  it('a throwing step does not stop later steps', async () => {
    const chain = createKeyedChain();
    const seen: string[] = [];
    chain('C1', async () => {
      throw new Error('boom');
    });
    chain('C1', async () => {
      seen.push('after');
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['after']);
  });
});

describe('SlackAdapter room metadata + selfIdentity', () => {
  const build = (fetchMetadata: boolean | undefined) => {
    const adapter = new SlackAdapter({
      botToken: 'xoxb-fake',
      appToken: 'xapp-fake',
      signingSecret: 'sig-fake',
      botKey: 'test-bot',
      ...(fetchMetadata !== undefined ? { fetchMetadata } : {}),
    });
    const priv = adapter as unknown as {
      roomMetadata?: (c: string) => Promise<unknown>;
      stampRoomMetadata: (
        m: InboundMessage,
        meta?: { effectiveMode?: string },
      ) => Promise<InboundMessage>;
    };
    return { adapter, priv };
  };
  const env = { platform: 'slack', chatId: 'C1', text: 'hi', isDm: false } as InboundMessage;

  it('has no metadata fetcher unless fetch_metadata is on', () => {
    expect(build(undefined).priv.roomMetadata).toBeUndefined();
    expect(build(false).priv.roomMetadata).toBeUndefined();
    expect(build(true).priv.roomMetadata).toBeTypeOf('function');
  });

  it('stamps roomMetadata and channelMode', async () => {
    const { priv } = build(true);
    priv.roomMetadata = async () => ({ topic: 't' });
    const out = await priv.stampRoomMetadata(env, { effectiveMode: 'thread_follow' });
    expect(out.roomMetadata).toEqual({ topic: 't' });
    expect(out.channelMode).toBe('thread_follow');
  });

  it('selfIdentity is undefined before auth.test, then name and user id', () => {
    const { adapter } = build(undefined);
    expect(adapter.selfIdentity()).toBeUndefined();
    const priv = adapter as unknown as { selfUserId: string; selfDisplayName: string };
    priv.selfUserId = 'U0BOT';
    priv.selfDisplayName = 'ethos';
    expect(adapter.selfIdentity()).toEqual({ handle: 'ethos', platformUserId: 'U0BOT' });
  });
});

describe('envelope meta carries effectiveMode only with fetch_metadata', () => {
  it('registerMessageEvents', async () => {
    const { registerMessageEvents } = await import('../events/messages');
    const run = async (fetchMetadata: boolean | undefined) => {
      const handlers = new Map<string, (args: unknown) => Promise<void>>();
      const app = {
        message: (fn: (args: unknown) => Promise<void>) => handlers.set('message', fn),
        event: (n: string, fn: (args: unknown) => Promise<void>) => handlers.set(`event:${n}`, fn),
      };
      const seen: unknown[] = [];
      registerMessageEvents(
        app as never,
        {
          botKey: 'b',
          defaultChannelMode: 'all',
          ...(fetchMetadata ? { fetchMetadata } : {}),
        },
        { onEnvelope: (_m, meta) => seen.push(meta) },
      );
      await handlers.get('message')?.({
        message: { channel: 'C1', user: 'U1', text: 'hi', ts: '1.1', channel_type: 'channel' },
      });
      return seen;
    };
    expect(await run(true)).toEqual([{ effectiveMode: 'all', modeSource: 'default' }]);
    expect(await run(undefined)).toEqual([undefined]);
  });
});
