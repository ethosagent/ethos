// Per-room prompt wiring (plan channel-prompts L3b, L5, D8): Gateway.runTurn
// resolves the room policy once per lane and hands AgentLoop.run the rendered
// block. Every route into runTurn (message, wake review, spool replay, voice
// note, Slack /ethos ask) must see the same bytes for the same room.

import {
  type AgentLoop,
  buildLaneKey,
  DefaultSttProviderRegistry,
  privateChatSetFrom,
} from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  AttachmentCache,
  BackgroundJob,
  DeliveryResult,
  InboundMessage,
  JobStore,
  OutboundMessage,
  PlatformAdapter,
  Session,
  SessionStore,
  Storage,
  SttProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig } from '../index';
import type { RoomPolicyTable } from '../room-policy';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function adapterFor(platform = 'telegram'): PlatformAdapter & { sends: string[] } {
  const sends: string[] = [];
  return {
    id: `${platform}:bot-a`,
    displayName: platform,
    capabilities: { platform },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    sends,
  } as unknown as PlatformAdapter & { sends: string[] };
}

type Opts = Record<string, unknown>;

function loopStub(impl?: () => AsyncGenerator<{ type: string; [k: string]: unknown }>) {
  const calls: Opts[] = [];
  const run = vi.fn((_text: string, opts: Opts) => {
    calls.push(opts);
    if (impl) return impl();
    return (async function* () {
      yield { type: 'done', text: 'reply', turnCount: 1 };
    })();
  });
  return { loop: { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } }, calls };
}

function msg(platform: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform,
    chatId: 'C1',
    userId: 'U1',
    text: 'hello',
    isDm: false,
    isGroupMention: true,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    botKey: 'bot-a',
    raw: {},
    ...overrides,
  };
}

function gateway(
  loop: unknown,
  roomPolicies: RoomPolicyTable | undefined,
  extra: Partial<GatewayConfig> = {},
): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...(roomPolicies ? { roomPolicies } : {}),
    ...extra,
  });
}

async function roomOpts(
  platform: string,
  message: Partial<InboundMessage>,
  table: RoomPolicyTable | undefined,
): Promise<Opts> {
  const s = loopStub();
  await gateway(s.loop, table).handleMessage(msg(platform, message), adapterFor(platform));
  expect(s.calls).toHaveLength(1);
  return s.calls[0] as Opts;
}

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

describe('voice note in a room', () => {
  it('a transcribed voice note gets the room block', async () => {
    const provider: SttProvider = {
      name: 'local-stt',
      caps: { kind: 'stt', formats: ['opus'], local: true, contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => 'book a table',
    };
    const registry = new DefaultSttProviderRegistry();
    registry.register('local-stt', () => provider);
    const attachmentCache: AttachmentCache = {
      write: async () => 'file:///cache/note.ogg',
      clear: async () => {},
      pruneOlderThan: async () => ({ removedCount: 0 }),
      resolveLocalPath: (url) => url.replace('file://', ''),
    };
    const storage = { readBytes: async () => Uint8Array.from([1, 2, 3]) } as unknown as Storage;
    const s = loopStub();
    const gw = gateway(
      s.loop,
      { telegram: { entries: { C1: { prompt: 'voice room' } } } },
      {
        attachmentCache,
        storage,
        sttProviderRegistry: registry,
        sttProviderName: 'local-stt',
      },
    );
    await gw.handleMessage(
      msg('telegram', {
        text: '',
        attachments: [
          { type: 'audio', ref: 'a1', url: 'file:///cache/note.ogg', mimeType: 'audio/ogg' },
        ],
      }),
      adapterFor('telegram'),
    );
    expect(s.calls[0]?.voiceOrigin).toBeDefined();
    expect(s.calls[0]?.roomPrompt).toBe('voice room');
  });
});

describe('D8 — gateway.room_policy_changed', () => {
  function sessionStoreFake() {
    const rows = new Map<string, Session>();
    const store = {
      getSessionByKey: async (key: string) => rows.get(key) ?? null,
      updateSession: async (id: string, patch: Partial<Session>) => {
        for (const row of rows.values()) if (row.id === id) Object.assign(row, patch);
      },
    } as unknown as SessionStore;
    return { store, rows };
  }

  async function turn(
    table: RoomPolicyTable,
    store: SessionStore,
    events: Array<Record<string, unknown>>,
  ) {
    const s = loopStub();
    const gw = gateway(s.loop, table, {
      sessionStore: () => store,
      observability: {
        recordSafetyBlock: (e: { code?: string; details?: Record<string, unknown> }) => {
          events.push({ code: e.code, ...e.details });
        },
      } as never,
    });
    await gw.handleMessage(msg('slack', { chatId: 'C1' }), adapterFor('slack'));
  }

  const changed = (events: Array<Record<string, unknown>>) =>
    events.filter((e) => e.code === 'gateway.room_policy_changed');

  it('stores the digest, stays quiet when unchanged, emits once when the prompt changes', async () => {
    const { store, rows } = sessionStoreFake();
    const key = buildLaneKey('slack', 'bot-a', 'C1');
    rows.set(key, { id: 'sess-1', key, metadata: { keep: 1 } } as unknown as Session);
    const events: Array<Record<string, unknown>> = [];
    const v1: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'v1' } } } };

    await turn(v1, store, events);
    expect(rows.get(key)?.metadata).toMatchObject({
      keep: 1,
      roomPolicyDigest: expect.any(String),
      roomPolicyIsDm: false,
    });
    expect(changed(events)).toHaveLength(0);

    await turn(v1, store, events); // a restart with the same config
    expect(changed(events)).toHaveLength(0);

    await turn({ slack: { entries: { C1: { prompt: 'v2' } } } }, store, events);
    expect(changed(events)).toHaveLength(1);
    await turn({ slack: { entries: { C1: { prompt: 'v2' } } } }, store, events);
    expect(changed(events)).toHaveLength(1);
    expect(rows.get(key)?.metadata).toMatchObject({ keep: 1 });
  });
});

describe('whole-block cap and unconfigured deployments', () => {
  it('records gateway.room_prompt_trimmed once per lane and still runs the turn', async () => {
    const events: Array<Record<string, unknown>> = [];
    const s = loopStub();
    const gw = gateway(
      s.loop,
      {
        discord: {
          entries: {
            P: { prompt: 'p'.repeat(3000) },
            'P.topics.T': { prompt: 't'.repeat(3000) },
            T: { prompt: 'd'.repeat(3000) },
          },
        },
      },
      {
        observability: {
          recordSafetyBlock: (e: { code?: string; details?: Record<string, unknown> }) => {
            events.push({ code: e.code, ...e.details });
          },
        } as never,
      },
    );
    const a = adapterFor('discord');
    await gw.handleMessage(msg('discord', { chatId: 'P', threadId: 'T' }), a);
    await gw.handleMessage(msg('discord', { chatId: 'P', threadId: 'T' }), a);
    const trimmed = events.filter((e) => e.code === 'gateway.room_prompt_trimmed');
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.dropped).toEqual(['T']);
    expect(String(s.calls[0]?.roomPrompt)).toHaveLength(6002);
  });

  it('a platform with no table entry does no session read for room policy', async () => {
    const getSessionByKey = vi.fn(async () => null);
    const store = { getSessionByKey, updateSession: vi.fn() } as unknown as SessionStore;
    const s = loopStub();
    const gw = gateway(
      s.loop,
      { slack: { entries: { '*': { prompt: 'x' } } } },
      {
        sessionStore: () => store,
      },
    );
    await gw.handleMessage(msg('telegram'), adapterFor('telegram'));
    expect(getSessionByKey).not.toHaveBeenCalled();
  });
});
