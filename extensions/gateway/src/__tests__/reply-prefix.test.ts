// Plan personality-presence-and-initiative §3 (identity shown on channels) —
// the per-bot `replyPrefix` template. The prefix is part of the CONTENT: it is
// applied by `applyReplyPrefix` before `MessageDedupCache.shouldSend` and before
// the delivery ledger writes its `pending` row, so the dedup key, the ledger
// row and a sweep redelivery all see the same bytes, and a redelivery is never
// prefixed a second time. With no `replyPrefix`, output is byte-identical.

import {
  type AgentLoop,
  type ChannelPresenceResolver,
  DefaultHookRegistry,
} from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_REPLY_NOTICE, Gateway, type GatewayConfig } from '../index';
import { LaneSessionFiles } from '../lane-sessions';
import { applyReplyPrefix } from '../reply-prefix';

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

describe('applyReplyPrefix', () => {
  const owl = { name: 'Owl', emoji: '🦉' };

  it('returns the text unchanged when no template is set', () => {
    expect(applyReplyPrefix('hello', undefined, owl)).toBe('hello');
    expect(applyReplyPrefix('hello', '', owl)).toBe('hello');
  });

  it('fills {name} and {emoji}', () => {
    expect(applyReplyPrefix('hello', '[{name}] ', owl)).toBe('[Owl] hello');
    expect(applyReplyPrefix('hello', '{emoji} {name}: ', owl)).toBe('🦉 Owl: hello');
  });

  it('drops an unset {emoji} without leaving a double or leading space', () => {
    const plain = { name: 'Owl' };
    expect(applyReplyPrefix('hello', '{emoji} {name}: ', plain)).toBe('Owl: hello');
    expect(applyReplyPrefix('hello', '[{name} {emoji}] ', plain)).toBe('[Owl] hello');
    expect(applyReplyPrefix('hello', '{name} {emoji} | ', plain)).toBe('Owl | hello');
    expect(applyReplyPrefix('hello', '{emoji} ', plain)).toBe('hello');
  });

  it('never re-expands a placeholder that appears inside a value', () => {
    expect(applyReplyPrefix('hi', '[{name}] ', { name: '{emoji}', emoji: '🦉' })).toBe(
      '[{emoji}] hi',
    );
  });

  it('leaves an empty text empty', () => {
    expect(applyReplyPrefix('', '[{name}] ', owl)).toBe('');
  });

  it.each([
    ['an ATX heading', '# Heading\nbody'],
    ['a dash list', '- one\n- two'],
    ['a star list', '* one\n* two'],
    ['a block quote', '> quoted'],
    ['an ordered list', '1. first\n2. second'],
    ['a code fence', '```ts\nconst x = 1;\n```'],
  ])('puts the prefix on its own line before %s', (_label, text) => {
    expect(applyReplyPrefix(text, '[{name}] ', owl)).toBe(`[Owl]\n${text}`);
    expect(applyReplyPrefix(text, '{emoji} {name}: ', owl)).toBe(`🦉 Owl:\n${text}`);
  });

  it('keeps the prefix inline for text that only looks like a block construct', () => {
    expect(applyReplyPrefix('#hashtag day', '[{name}] ', owl)).toBe('[Owl] #hashtag day');
    expect(applyReplyPrefix('*bold* move', '[{name}] ', owl)).toBe('[Owl] *bold* move');
    expect(applyReplyPrefix('-5 degrees', '[{name}] ', owl)).toBe('[Owl] -5 degrees');
    expect(applyReplyPrefix('2025 was long', '[{name}] ', owl)).toBe('[Owl] 2025 was long');
  });

  it('is deterministic — the same text renders the same bytes every time', () => {
    const text = '# Plan\n- a';
    expect(applyReplyPrefix(text, '[{name}] ', owl)).toBe(applyReplyPrefix(text, '[{name}] ', owl));
  });
});

// ---------------------------------------------------------------------------
// Gateway fixtures
// ---------------------------------------------------------------------------

function sendAdapter(opts: { ok?: boolean; canEdit?: boolean } = {}) {
  const sent: string[] = [];
  const edits: string[] = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: opts.canEdit ?? false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sent.push(m.text);
      return opts.ok === false
        ? { ok: false, error: 'platform rejected the message' }
        : { ok: true, messageId: String(nextId++) };
    }),
    ...(opts.canEdit
      ? {
          editMessage: vi.fn(
            async (_c: string, messageId: string, text: string): Promise<DeliveryResult> => {
              edits.push(text);
              return { ok: true, messageId };
            },
          ),
        }
      : {}),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent, edits });
}

function loopOf(events: AgentEvent[], hooks = new DefaultHookRegistry()): AgentLoop {
  return {
    run: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    hooks,
  } as unknown as AgentLoop;
}

const answerTurn: AgentEvent[] = [
  { type: 'text_delta', text: 'the answer' },
  { type: 'done', text: 'the answer', turnCount: 1 },
];

const streamedTurn: AgentEvent[] = [
  { type: 'text_delta', text: 'Hello ' },
  { type: 'text_delta', text: 'world' },
  { type: 'done', text: 'Hello world', turnCount: 1 },
];

const errorTurn: AgentEvent[] = [
  { type: 'error', error: 'provider exploded', code: 'provider_error' },
  { type: 'done', text: '', turnCount: 1 },
];

function claimedLoop(reply: string): AgentLoop {
  const hooks = new DefaultHookRegistry();
  hooks.registerClaiming('gateway_message', async () => ({ handled: true, reply }));
  return loopOf([{ type: 'done', text: 'agent', turnCount: 1 }], hooks);
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hi',
    // A group: `streamingEdits.group` defaults to false, so replies take the
    // non-streamed path that gates on dedup. Streaming cases pass isDm: true.
    isDm: false,
    isGroupMention: true,
    botKey: 'bot-a',
    messageId: `m${Math.random()}`,
    raw: {},
    ...overrides,
  };
}

const DIRECTORY: NonNullable<GatewayConfig['personalityDirectory']> = {
  refresh: async () => {},
  has: (id) => id === 'owl' || id === 'fox',
  list: () => [
    { id: 'owl', name: 'Owl', isDefault: true },
    { id: 'fox', name: 'Fox', isDefault: false },
  ],
  identity: (id) =>
    id === 'owl' ? { name: 'Owl', emoji: '🦉' } : id === 'fox' ? { name: 'Fox' } : undefined,
};

function gateway(
  loop: AgentLoop,
  opts: { replyPrefix?: string; allowSlashSwitch?: boolean } = {},
  extra: Partial<GatewayConfig> = {},
): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop,
        binding: {
          type: 'personality',
          name: 'owl',
          ...(opts.allowSlashSwitch ? { allowSlashSwitch: true } : {}),
        },
        ...(opts.replyPrefix !== undefined ? { replyPrefix: opts.replyPrefix } : {}),
      },
    ],
    personalityDirectory: DIRECTORY,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    streamingEditIntervalMs: 0,
    deliverySweepIntervalMs: 0,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// No new keys → byte-identical output
// ---------------------------------------------------------------------------

describe('no replyPrefix configured — channel output is byte-identical', () => {
  it('non-streamed answer, error note and hook-claimed reply carry no prefix', async () => {
    const a = sendAdapter();
    await gateway(loopOf(answerTurn)).handleMessage(msg(), a);
    await gateway(loopOf(errorTurn)).handleMessage(msg(), a);
    await gateway(claimedLoop('pong')).handleMessage(msg(), a);
    expect(a.sent).toEqual(['the answer', '⚠ Error: provider exploded', 'pong']);
  });

  it('the streamed first chunk and terminal edit carry no prefix', async () => {
    const a = sendAdapter({ canEdit: true });
    await gateway(loopOf(streamedTurn)).handleMessage(msg({ isDm: true }), a);
    expect(a.sent).toEqual(['Hello']);
    expect(a.edits.at(-1)).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// Every reply path carries the prefix exactly once
// ---------------------------------------------------------------------------

describe('replyPrefix on every reply path', () => {
  const prefix = '{emoji} {name}: ';

  it('the non-streamed answer', async () => {
    const a = sendAdapter();
    await gateway(loopOf(answerTurn), { replyPrefix: prefix }).handleMessage(msg(), a);
    expect(a.sent).toEqual(['🦉 Owl: the answer']);
  });

  it('an interrupted non-streamed answer carries it once, before the answer text', async () => {
    const a = sendAdapter();
    await gateway(
      loopOf([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'boom', code: 'provider_error' },
        { type: 'done', text: '', turnCount: 1 },
      ]),
      { replyPrefix: prefix },
    ).handleMessage(msg(), a);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]?.startsWith('🦉 Owl: partial\n\n⚠ Response interrupted')).toBe(true);
  });

  it('the hook-claimed reply', async () => {
    const a = sendAdapter();
    await gateway(claimedLoop('pong'), { replyPrefix: prefix }).handleMessage(msg(), a);
    expect(a.sent).toEqual(['🦉 Owl: pong']);
  });

  // Gateway notices are not the personality speaking: no prefix on any of them,
  // on either empty-reply path.
  it('the empty-reply notice after a blank done — no prefix', async () => {
    const a = sendAdapter();
    await gateway(loopOf([{ type: 'done', text: '', turnCount: 1 }]), {
      replyPrefix: prefix,
    }).handleMessage(msg(), a);
    expect(a.sent).toEqual([EMPTY_REPLY_NOTICE]);
  });

  it('the empty-completion notice after an empty_completion error — no prefix', async () => {
    const a = sendAdapter();
    await gateway(
      loopOf([
        { type: 'error', error: 'The model returned nothing.', code: 'empty_completion' },
        { type: 'done', text: '', turnCount: 1 },
      ]),
      { replyPrefix: prefix },
    ).handleMessage(msg(), a);
    expect(a.sent).toEqual(['⚠ The model returned nothing. Send it again or rephrase.']);
  });

  it('the error note of a turn that wrote no answer — no prefix', async () => {
    const a = sendAdapter();
    await gateway(loopOf(errorTurn), { replyPrefix: prefix }).handleMessage(msg(), a);
    expect(a.sent).toEqual(['⚠ Error: provider exploded']);
  });

  it('the streaming path: first chunk, every edit and the terminal edit carry it exactly once', async () => {
    const a = sendAdapter({ canEdit: true });
    await gateway(loopOf(streamedTurn), { replyPrefix: '[{name}] ' }).handleMessage(
      msg({ isDm: true }),
      a,
    );
    expect(a.sent).toEqual(['[Owl] Hello']);
    expect(a.edits.length).toBeGreaterThan(0);
    for (const body of [...a.sent, ...a.edits]) {
      expect(body.startsWith('[Owl] ')).toBe(true);
      expect(body.split('[Owl]').length - 1).toBe(1);
    }
    expect(a.edits.at(-1)).toBe('[Owl] Hello world');
  });

  it('an interrupted streamed reply folds the note into the draft with one prefix', async () => {
    const a = sendAdapter({ canEdit: true });
    await gateway(
      loopOf([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'boom', code: 'provider_error' },
        { type: 'done', text: '', turnCount: 1 },
      ]),
      { replyPrefix: '[{name}] ' },
    ).handleMessage(msg({ isDm: true }), a);
    const final = a.edits.at(-1) ?? '';
    expect(final.startsWith('[Owl] partial')).toBe(true);
    expect(final.split('[Owl]').length - 1).toBe(1);
  });

  it('{name} follows a /personality switch on the lane', async () => {
    const a = sendAdapter();
    const gw = gateway(loopOf(answerTurn), { replyPrefix: prefix, allowSlashSwitch: true });
    const dm = { isDm: true, isGroupMention: false };
    await gw.handleMessage(msg({ ...dm, text: '/personality fox' }), a);
    await gw.handleMessage(msg({ ...dm, text: 'hello' }), a);
    // Fox has no emoji: no leading space, no double space.
    expect(a.sent.at(-1)).toBe('Fox: the answer');
  });
});

// ---------------------------------------------------------------------------
// Dedup and the delivery ledger see the prefixed bytes
// ---------------------------------------------------------------------------

describe('replyPrefix with dedup and the delivery ledger', () => {
  it('a prefixed reply sent twice inside the TTL goes out once', async () => {
    const a = sendAdapter();
    // `dedupWindow: 0` turns inbound dedup off, so the second run of the SAME
    // message reaches the reply path and the outbound dedup key drops it.
    const gw = gateway(loopOf(answerTurn), { replyPrefix: '[{name}] ' }, { dedupWindow: 0 });
    const one = msg({ messageId: 'm-1' });
    await gw.handleMessage(one, a);
    await gw.handleMessage(one, a);
    expect(a.sent).toEqual(['[Owl] the answer']);
  });

  it('a ledger sweep redelivers the prefixed text byte for byte, never re-prefixed', async () => {
    const store = new SQLiteDeliveryLedger(':memory:');
    const failing = sendAdapter({ ok: false });
    await gateway(
      loopOf(answerTurn),
      { replyPrefix: '[{name}] ' },
      { deliveryLedger: store },
    ).handleMessage(msg(), failing);

    const pending = await store.listPending(['bot-a']);
    expect(pending.map((r) => r.content)).toEqual(['[Owl] the answer']);

    const healthy = sendAdapter();
    const rebooted = gateway(
      loopOf(answerTurn),
      { replyPrefix: '[{name}] ' },
      { deliveryLedger: store, adapters: new Map([['telegram', healthy]]) },
    );
    expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.sent).toEqual(['[Owl] the answer']);
  });
});

// ---------------------------------------------------------------------------
// The presence resolver the gateway hands its adapters
// ---------------------------------------------------------------------------

describe('Gateway presence for adapters', () => {
  it('binds a resolver on every adapter that asks for one, following /personality', async () => {
    let resolve: ChannelPresenceResolver | undefined;
    const a = Object.assign(sendAdapter(), {
      setPresenceResolver: (fn: ChannelPresenceResolver) => {
        resolve = fn;
      },
    });
    const gw = gateway(
      loopOf(answerTurn),
      { allowSlashSwitch: true },
      { adapters: new Map([['telegram', a]]) },
    );
    expect(resolve?.('chat-1')).toEqual({ name: 'Owl', emoji: '🦉' });

    await gw.handleMessage(msg({ isDm: true, isGroupMention: false, text: '/personality fox' }), a);
    expect(resolve?.('chat-1')).toEqual({ name: 'Fox' });
    // Another chat keeps the bound personality.
    expect(resolve?.('chat-2')).toEqual({ name: 'Owl', emoji: '🦉' });
  });

  it('names the personality the turn runs as, even for an override restored on a bot that no longer allows switching', async () => {
    // An earlier process (switching allowed then) left the lane on `fox`;
    // this one boots with switching off. `runTurn` still runs the lane as
    // `fox`, so the prefix and the adapter's resolver must say Fox too.
    const storage = new InMemoryStorage();
    await new LaneSessionFiles(storage, '/state').save('bot-a', {
      'telegram:bot-a:chat-1': { sessionKey: 'telegram:bot-a:chat-1:1', personalityId: 'fox' },
    });
    let resolve: ChannelPresenceResolver | undefined;
    const a = Object.assign(sendAdapter(), {
      setPresenceResolver: (fn: ChannelPresenceResolver) => {
        resolve = fn;
      },
    });
    const loop = loopOf(answerTurn);
    const gw = gateway(
      loop,
      { replyPrefix: '[{name}] ' },
      { adapters: new Map([['telegram', a]]), storage, dataDir: '/state' },
    );
    await gw.restoreLaneSessions();

    await gw.handleMessage(msg(), a);
    const runOpts = (loop.run as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1];
    expect((runOpts as { personalityId?: string }).personalityId).toBe('fox');
    expect(a.sent).toEqual(['[Fox] the answer']);
    expect(resolve?.('chat-1')).toEqual({ name: 'Fox' });
  });

  it('binds a hot-added adapter too', () => {
    let resolve: ChannelPresenceResolver | undefined;
    const gw = gateway(loopOf(answerTurn));
    const b = Object.assign(sendAdapter(), {
      id: 'telegram:bot-b',
      setPresenceResolver: (fn: ChannelPresenceResolver) => {
        resolve = fn;
      },
    });
    gw.addAdapter(b, {
      botKey: 'bot-b',
      loop: loopOf(answerTurn),
      binding: { type: 'personality', name: 'fox' },
    });
    expect(resolve?.('chat-9')).toEqual({ name: 'Fox' });
  });

  it('falls back to the personality id when the directory has no identity for it', () => {
    let resolve: ChannelPresenceResolver | undefined;
    const a = Object.assign(sendAdapter(), {
      setPresenceResolver: (fn: ChannelPresenceResolver) => {
        resolve = fn;
      },
    });
    new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: loopOf(answerTurn),
          binding: { type: 'personality', name: 'owl' },
        },
      ],
      adapters: new Map([['telegram', a]]),
      clarifySweepIntervalMs: 0,
      deliverySweepIntervalMs: 0,
    });
    expect(resolve?.('chat-1')).toEqual({ name: 'owl' });
  });
});
