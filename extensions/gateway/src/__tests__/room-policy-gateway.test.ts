// Per-room prompt wiring (plan channel-prompts L3b, L5, D8); shared setup in room-policy-gateway.fixtures.ts.

import { type AgentLoop, buildLaneKey, privateChatSetFrom } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  BackgroundJob,
  InboundMessage,
  JobStore,
  PlatformAdapter,
  Session,
  SessionStore,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';
import type { RoomPolicyTable } from '../room-policy';
import {
  adapterFor,
  gateway,
  loopStub,
  msg,
  type Opts,
  roomOpts,
  waitUntil,
} from './room-policy-gateway.fixtures';

describe('room policy reaches AgentLoop.run (plan channel-prompts L3b)', () => {
  it('Slack thread: the channel (parent) entry applies', async () => {
    const o = await roomOpts(
      'slack',
      { chatId: 'C1', threadId: '1700.1' },
      {
        slack: { entries: { C1: { prompt: 'channel prompt' } } },
      },
    );
    expect(o.roomPrompt).toBe('channel prompt');
  });

  it('Discord thread: parent prompt, then the thread entry', async () => {
    const o = await roomOpts(
      'discord',
      { chatId: 'P1', threadId: 'T9' },
      {
        discord: { entries: { P1: { prompt: 'parent' }, T9: { prompt: 'thread' } } },
      },
    );
    expect(o.roomPrompt).toBe('parent\n\nthread');
  });

  it('Telegram topic: group prompt, then the topic prompt (both layers)', async () => {
    const o = await roomOpts(
      'telegram',
      { chatId: '-100', threadId: '5' },
      {
        telegram: {
          entries: { '-100': { prompt: 'group' }, '-100.topics.5': { prompt: 'topic' } },
        },
      },
    );
    expect(o.roomPrompt).toBe('group\n\ntopic');
  });

  it('WhatsApp group', async () => {
    const o = await roomOpts(
      'whatsapp',
      { chatId: '123@g.us' },
      {
        whatsapp: { entries: { '123@g.us': { prompt: 'wa group' } } },
      },
    );
    expect(o.roomPrompt).toBe('wa group');
  });

  it('email DM gets the *dm entry', async () => {
    const o = await roomOpts(
      'email',
      { chatId: 'u:inbox', isDm: true, isGroupMention: false },
      {
        email: { entries: { '*dm': { prompt: 'mailbox' } } },
      },
    );
    expect(o.roomPrompt).toBe('mailbox');
  });

  it('two rooms on one bot get two different prompts', async () => {
    const table: RoomPolicyTable = {
      slack: { entries: { C1: { prompt: 'one' }, C2: { prompt: 'two' } } },
    };
    const s = loopStub();
    const gw = gateway(s.loop, table);
    const a = adapterFor('slack');
    await gw.handleMessage(msg('slack', { chatId: 'C1' }), a);
    await gw.handleMessage(msg('slack', { chatId: 'C2' }), a);
    expect(s.calls.map((c) => c.roomPrompt)).toEqual(['one', 'two']);
  });

  it('a DM never gets *, a room never gets *dm', async () => {
    const table: RoomPolicyTable = {
      slack: { entries: { '*': { prompt: 'rooms' }, '*dm': { prompt: 'dms' } } },
    };
    const dm = await roomOpts('slack', { chatId: 'D1', isDm: true, isGroupMention: false }, table);
    const room = await roomOpts('slack', { chatId: 'C1' }, table);
    expect(dm.roomPrompt).toBe('dms');
    expect(room.roomPrompt).toBe('rooms');
    const onlyStar: RoomPolicyTable = { slack: { entries: { '*': { prompt: 'rooms' } } } };
    const bare = await roomOpts(
      'slack',
      { chatId: 'D1', isDm: true, isGroupMention: false },
      onlyStar,
    );
    expect('roomPrompt' in bare).toBe(false);
  });

  it('a platform absent from the table, or no table, passes no room keys at all', async () => {
    for (const table of [{ slack: { entries: { '*': { prompt: 'x' } } } }, undefined]) {
      const o = await roomOpts('telegram', {}, table);
      for (const k of [
        'roomPrompt',
        'roomSkills',
        'modelOverride',
        'modelOverrideSource',
        'tierOverride',
      ]) {
        expect(k in o, k).toBe(false);
      }
    }
  });

  it('a Slack /ethos ask-shaped envelope gets the same bytes as a plain message', async () => {
    const table: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'p' } } } };
    const plain = await roomOpts('slack', { chatId: 'C1', threadId: '1.2' }, table);
    const ask = await roomOpts(
      'slack',
      {
        chatId: 'C1',
        threadId: '1.2',
        text: 'what is up',
        raw: { command: '/ethos', text: 'ask what is up' },
      },
      table,
    );
    expect(ask.roomPrompt).toBe(plain.roomPrompt);
  });

  it('passes roomSkills when the entry has skills, none otherwise', async () => {
    const o = await roomOpts(
      'slack',
      {},
      {
        slack: { entries: { C1: { prompt: 'p', skills: ['incident'] } } },
      },
    );
    expect(o.roomSkills).toEqual(['incident']);
    const none = await roomOpts('slack', {}, { slack: { entries: { C1: { prompt: 'p' } } } });
    expect('roomSkills' in none).toBe(false);
  });
});

describe('room model and tier (L5)', () => {
  it('model -> modelOverride labelled as the room, no tierOverride', async () => {
    const o = await roomOpts('slack', {}, { slack: { entries: { C1: { model: 'haiku' } } } });
    expect(o.modelOverride).toBe('haiku');
    expect(o.modelOverrideSource).toBe('room');
    expect('tierOverride' in o).toBe(false);
    expect('roomPrompt' in o).toBe(false);
  });

  it('tier -> tierOverride, no modelOverride', async () => {
    const o = await roomOpts('slack', {}, { slack: { entries: { C1: { tier: 'deep' } } } });
    expect(o.tierOverride).toBe('deep');
    expect('modelOverride' in o).toBe(false);
  });

  it('the wildcard supplies model when the room entry does not', async () => {
    const o = await roomOpts(
      'slack',
      {},
      {
        slack: { entries: { '*': { model: 'haiku' }, C1: { prompt: 'p' } } },
      },
    );
    expect(o.modelOverride).toBe('haiku');
  });
});

describe('same bytes through every route into runTurn (D8 pin)', () => {
  function recordingAdapter() {
    return adapterFor('telegram');
  }

  async function firstThenSecond(table: RoomPolicyTable) {
    // The original message turn, never finishing (a crash analogue), then a
    // second process replaying it from the spool.
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const first = loopStub(async function* () {
      await new Promise(() => {});
    });
    const extra = {
      adapters: new Map([['telegram', out as PlatformAdapter]]),
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
      clarifyEscalationDelayMs: 0,
    } satisfies Partial<GatewayConfig>;
    void gateway(first.loop, table, extra).handleMessage(
      msg('telegram', { chatId: 'chat-1', isDm: false }),
      out,
    );
    await waitUntil(() => first.calls.length === 1);
    const second = loopStub();
    await gateway(second.loop, table, extra).replayInboundSpool();
    await waitUntil(() => second.calls.length === 1);
    return { first: first.calls[0] as Opts, replayed: second.calls[0] as Opts };
  }

  it('a spool replay gets the original turn bytes', async () => {
    const { first, replayed } = await firstThenSecond({
      telegram: { entries: { 'chat-1': { prompt: 'room-x', skills: ['s1'] } } },
    });
    expect(first.roomPrompt).toBe('room-x');
    expect(replayed.roomPrompt).toBe(first.roomPrompt);
    expect(replayed.roomSkills).toEqual(first.roomSkills);
  });

  function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
    return {
      id: 'job-1234abcd',
      owner: 'proc-1',
      parentSessionKey: 'telegram:bot-a:chat-1',
      rootSessionKey: 'telegram:bot-a:chat-1',
      childSessionKey: 'child',
      depth: 1,
      status: 'done',
      prompt: 'check',
      summary: 'done',
      spendUsd: 0,
      createdAt: Date.now(),
      originPlatform: 'telegram',
      originBotKey: 'bot-a',
      originChatId: 'chat-1',
      deliver: 'parent',
      ...overrides,
    };
  }

  function fakeJobStore(j: BackgroundJob): JobStore {
    return {
      get: async () => j,
      claimDelivery: vi.fn(async () => {
        if (j.deliveredAt !== undefined) return false;
        j.deliveredAt = Date.now();
        return true;
      }),
      releaseDelivery: async () => {
        j.deliveredAt = undefined;
      },
      listUndelivered: async () => (j.deliveredAt === undefined ? [j] : []),
    } as unknown as JobStore;
  }

  async function reviewOpts(
    table: RoomPolicyTable,
    j: BackgroundJob,
    priorMessage?: Partial<InboundMessage>,
    extra: Partial<GatewayConfig> = {},
  ): Promise<{ review: Opts; prior?: Opts }> {
    const spool = new SQLiteInboundSpool(':memory:');
    const out = recordingAdapter();
    const s = loopStub();
    const handlers: Array<(x: BackgroundJob) => void> = [];
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: s.loop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
          jobStore: fakeJobStore(j),
          backgroundExecutor: {
            owner: 'proc-1',
            nudge: vi.fn(),
            onComplete: (h: (x: BackgroundJob) => void) => {
              handlers.push(h);
              return () => {};
            },
          } as never,
        },
      ],
      adapters: new Map([['telegram', out as PlatformAdapter]]),
      inboundSpool: spool,
      deliveryLedger: new SQLiteDeliveryLedger(':memory:'),
      inboundSpoolOptions: { replayIntervalMs: 0 },
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
      roomPolicies: table,
      ...extra,
    });
    let prior: Opts | undefined;
    if (priorMessage) {
      await gw.handleMessage(msg('telegram', { chatId: 'chat-1', ...priorMessage }), out);
      prior = s.calls[0];
    }
    for (const h of handlers) h(j);
    await waitUntil(() => s.calls.some((c) => c.reviewOfJobId !== undefined));
    return {
      review: s.calls.find((c) => c.reviewOfJobId !== undefined) as Opts,
      ...(prior ? { prior } : {}),
    };
  }

  it('a wake review on a group lane gets the same block as the message turn', async () => {
    const { review, prior } = await reviewOpts(
      { telegram: { entries: { 'chat-1': { prompt: 'room-x' }, '*dm': { prompt: 'dm-y' } } } },
      job({ roomAudience: 'shared' }),
      { isDm: false },
    );
    expect(prior?.roomPrompt).toBe('room-x');
    expect(review.roomPrompt).toBe('room-x');
  });

  const dmTable: RoomPolicyTable = {
    telegram: { entries: { '*': { prompt: 'rooms' }, '*dm': { prompt: 'dms' } } },
  };

  it('wake review isDm: a review after a real DM message gets *dm, never *', async () => {
    const withPrior = await reviewOpts(dmTable, job({ roomAudience: 'private' }), {
      isDm: true,
      isGroupMention: false,
    });
    expect(withPrior.prior?.roomPrompt).toBe('dms');
    expect(withPrior.review.roomPrompt).toBe('dms');
  });

  it('wake review isDm: a DM whose job was stamped shared, reviewed cold, gets *dm (stored isDm)', async () => {
    // The restart analogue: no in-process note, but the session row carries what the
    // lane's last real message stored.
    const key = buildLaneKey('telegram', 'bot-a', 'chat-1');
    const session = {
      id: 'sess-dm',
      key,
      metadata: { roomPolicyIsDm: true },
    } as unknown as Session;
    const store = {
      getSessionByKey: async (k: string) => (k === key ? session : null),
      updateSession: async () => {},
    } as unknown as SessionStore;
    const cold = await reviewOpts(dmTable, job({ roomAudience: 'shared' }), undefined, {
      sessionStore: () => store,
    });
    expect(cold.review.roomPrompt).toBe('dms');
  });

  it('wake review isDm: a shared review on a private DM lane (sub-session) still gets *dm', async () => {
    // A positive Telegram chat id is a private lane, so the shared review runs in
    // `${lane}:review:${jobId}`; the lane's DM-ness must be read off the LANE session.
    const withPrior = await reviewOpts(
      dmTable,
      job({ roomAudience: 'shared', originChatId: '4242' }),
      { chatId: '4242', isDm: true, isGroupMention: false },
    );
    expect(withPrior.prior?.roomPrompt).toBe('dms');
    expect(withPrior.review.roomPrompt).toBe('dms');
  });

  it('wake review isDm: a private_chats group, reviewed cold, gets * not *dm', async () => {
    const cold = await reviewOpts(dmTable, job({ roomAudience: 'private' }), undefined, {
      privateChats: privateChatSetFrom({ telegram: ['chat-1'] }),
    });
    expect(cold.review.roomPrompt).toBe('rooms');
  });

  it('wake review isDm: cold with nothing stored, a private job on an unlisted chat reads as a DM', async () => {
    const cold = await reviewOpts(dmTable, job({ roomAudience: 'private' }));
    expect(cold.review.roomPrompt).toBe('dms');
  });

  it('a review never writes the digest or isDm (non-authoritative)', async () => {
    const key = buildLaneKey('telegram', 'bot-a', 'chat-1');
    const updates: unknown[] = [];
    const session = { id: 's', key, metadata: {} } as unknown as Session;
    const store = {
      getSessionByKey: async () => session,
      updateSession: async (_id: string, patch: unknown) => {
        updates.push(patch);
      },
    } as unknown as SessionStore;
    await reviewOpts(dmTable, job({ roomAudience: 'shared' }), undefined, {
      sessionStore: () => store,
    });
    expect(updates).toEqual([]);
  });
});
