// UBP-014 (plan/phases/upstream-bug-parity.md, owner decision D2) — reply-path
// dedup is keyed on the INBOUND message (ARCHITECTURE.md §V S3 as amended
// 2026-09-28). A correct reply to a new message used to be dropped when its
// text equalled the previous reply in the lane inside the 30s TTL: "delete
// a.txt" → "Done.", "delete b.txt" → (nothing). Each inbound now gets its own
// terminal delivery; a double send of ONE reply is still a silent drop.

import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MessageDedupCache } from '../dedup';
import { EMPTY_REPLY_NOTICE, Gateway } from '../index';
import { DraftStreamer } from '../streaming';

function recordingAdapter() {
  const sends: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function doneLoop(text: string) {
  return {
    run: vi.fn(async function* () {
      yield { type: 'text_delta', text };
      yield { type: 'done', text, turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  } as unknown as AgentLoop;
}

function msg(text: string, messageId: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'group-1',
    userId: 'user-1',
    text,
    // A group: `streamingEdits.group` defaults to false, so the reply takes the
    // non-streamed path that gates on dedup.
    isDm: false,
    isGroupMention: true,
    botKey: 'bot-a',
    messageId,
    raw: {},
  };
}

function gateway(loop: AgentLoop, adapter: PlatformAdapter): Gateway {
  return new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([['telegram', adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
}

describe('reply dedup is scoped to the inbound message (UBP-014)', () => {
  it('two different messages whose correct replies are identical both get the reply', async () => {
    const out = recordingAdapter();
    const gw = gateway(doneLoop('Done.'), out.adapter);
    await gw.handleMessage(msg('delete a.txt', 'm-1'), out.adapter);
    await gw.handleMessage(msg('delete b.txt', 'm-2'), out.adapter);
    expect(out.sends).toEqual(['Done.', 'Done.']);
  });

  it('the same inbound message delivered twice is still answered once', async () => {
    const out = recordingAdapter();
    const loop = doneLoop('Done.');
    const gw = gateway(loop, out.adapter);
    // Inbound dedup drops the platform's redelivery before a turn runs; the
    // reply-path key covers a second answer to the SAME message.
    await gw.handleMessage(msg('delete a.txt', 'm-1'), out.adapter);
    await gw.handleMessage(msg('delete a.txt', 'm-1'), out.adapter);
    expect(out.sends).toEqual(['Done.']);
  });

  it('the streamed final registers under its inbound message, not the lane', async () => {
    const dedup = new MessageDedupCache({ ttlMs: 60_000 });
    const adapter = {
      send: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, messageId: 'd1' })),
      editMessage: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true })),
    };
    const streamer = new DraftStreamer({
      adapter,
      chatId: 'c1',
      threadId: undefined,
      sessionKey: 's1',
      dedup,
      inboundId: 'in-1',
      minEditIntervalMs: 0,
    });
    await streamer.pushText('Done.');
    await streamer.finalize('Done.');
    expect(dedup.wouldSend('s1', 'Done.', { inboundId: 'in-1' })).toBe(false);
    expect(dedup.wouldSend('s1', 'Done.', { inboundId: 'in-2' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every reply path, not just the final answer (RFC limitations 3 and 4).
//
// Each path: identical text to two DIFFERENT inbound messages → both sent;
// the SAME inbound message run twice → one send. `dedupWindow: 0` turns
// inbound dedup off, so the second run of one message reaches the reply path
// and the scoped key — not inbound dedup — is what drops it.
// ---------------------------------------------------------------------------

function loopOf(events: Array<Record<string, unknown>>, hooks?: DefaultHookRegistry) {
  return {
    run: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    hooks: hooks ?? new DefaultHookRegistry(),
  } as unknown as AgentLoop;
}

function scopedGateway(loop: AgentLoop, extra: Record<string, unknown> = {}): Gateway {
  return new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    dedupWindow: 0,
    ...extra,
  });
}

async function sendsFor(
  makeLoop: () => AgentLoop,
  ids: [string | undefined, string | undefined],
  extra: Record<string, unknown> = {},
  sameObject = false,
): Promise<string[]> {
  const out = recordingAdapter();
  const gw = scopedGateway(makeLoop(), extra);
  const first = { ...msg('same question', ids[0] ?? ''), messageId: ids[0] };
  const second = sameObject ? first : { ...msg('same question', ids[1] ?? ''), messageId: ids[1] };
  await gw.handleMessage(first, out.adapter);
  await gw.handleMessage(second, out.adapter);
  return out.sends;
}

const errorTurn = () =>
  loopOf([
    { type: 'error', error: 'provider exploded', code: 'provider_error' },
    { type: 'done', text: '', turnCount: 1 },
  ]);

const blankTurn = () => loopOf([{ type: 'done', text: '', turnCount: 1 }]);

const credentialTurn = () =>
  loopOf([
    {
      type: 'credential_required',
      pluginId: 'weather',
      credentialKey: 'API_KEY',
      kind: 'api_key',
      label: 'Weather API key',
      sessionKey: 's',
      pendingUserMessage: 'same question',
    },
    { type: 'done', text: '', turnCount: 0 },
  ]);

function claimedTurn() {
  const hooks = new DefaultHookRegistry();
  hooks.registerClaiming('gateway_message', async () => ({ handled: true, reply: 'pong' }));
  return loopOf([{ type: 'done', text: 'agent', turnCount: 1 }], hooks);
}

// A loader is wired so the gateway opts turns into the credential prompt.
const CREDENTIALS = {
  pluginLoader: { setCredential: vi.fn(), getPlatformAdapters: () => new Map() },
};

describe('reply dedup scope — the error note, the notices and the hook-claimed reply', () => {
  const PATHS: Array<[string, () => AgentLoop, string, Record<string, unknown>]> = [
    ['the error note', errorTurn, '⚠ Error: provider exploded', {}],
    ['EMPTY_REPLY_NOTICE', blankTurn, EMPTY_REPLY_NOTICE, {}],
    [
      'the credential-required reply',
      credentialTurn,
      'ethos plugin credentials weather',
      CREDENTIALS,
    ],
    ['the hook-claimed reply', claimedTurn, 'pong', {}],
  ];

  for (const [name, makeLoop, expected, extra] of PATHS) {
    it(`${name}: identical text to two different inbound messages is sent twice`, async () => {
      const sends = await sendsFor(makeLoop, ['m-1', 'm-2'], extra);
      expect(sends).toHaveLength(2);
      for (const text of sends) expect(text).toContain(expected);
      expect(sends[0]).toBe(sends[1]);
    });

    it(`${name}: the same inbound message run twice is sent once`, async () => {
      const sends = await sendsFor(makeLoop, ['m-1', 'm-1'], extra);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain(expected);
    });
  }
});

describe('a message with no spool row and no platform id', () => {
  it('gets its own reply key: two such messages with identical replies both send', async () => {
    const sends = await sendsFor(() => doneLoop('Done.'), [undefined, undefined]);
    expect(sends).toEqual(['Done.', 'Done.']);
  });

  it('one such message answered twice is still sent once', async () => {
    const sends = await sendsFor(() => doneLoop('Done.'), [undefined, undefined], {}, true);
    expect(sends).toEqual(['Done.']);
  });
});

describe('Gateway.recordRedelivered re-arms the scoped key (RFC limitation 4)', () => {
  it('a redelivered reply blocks a second send to ITS inbound message, not to another', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: doneLoop('x'), binding: { type: 'personality', name: 'default' } },
      ],
      adapters: new Map([['telegram', out.adapter]]),
      deliveryLedger: ledger,
      clarifySweepIntervalMs: 0,
      outboundDedupTtlMs: 600_000,
    });
    await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'group-1',
      sessionId: 'sess-1',
      content: 'Done.',
      inboundRef: 'spool-1',
    });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(out.sends).toEqual(['Done.']);

    // biome-ignore lint/complexity/useLiteralKeys: private field, read for the assertion
    const cache = gw['outboundDedup'];
    // The reply path of the SAME inbound message is now suppressed ...
    expect(cache.wouldSend('sess-1', 'Done.', { inboundId: 'spool-1' })).toBe(false);
    // ... and so is a content-only send (a notice, an agent-initiated send) ...
    expect(cache.wouldSend('sess-1', 'Done.')).toBe(false);
    // ... while the same text answering a DIFFERENT inbound message still sends.
    expect(cache.wouldSend('sess-1', 'Done.', { inboundId: 'spool-2' })).toBe(true);
    ledger.close();
  });

  it('a row with no inboundRef re-arms only the content-only key', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: doneLoop('x'), binding: { type: 'personality', name: 'default' } },
      ],
      adapters: new Map([['telegram', out.adapter]]),
      deliveryLedger: ledger,
      clarifySweepIntervalMs: 0,
      outboundDedupTtlMs: 600_000,
    });
    await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'group-1',
      sessionId: 'sess-1',
      content: 'Done.',
    });
    await gw.sweepPendingDeliveries();
    // biome-ignore lint/complexity/useLiteralKeys: private field, read for the assertion
    const cache = gw['outboundDedup'];
    expect(cache.wouldSend('sess-1', 'Done.')).toBe(false);
    expect(cache.wouldSend('sess-1', 'Done.', { inboundId: 'spool-1' })).toBe(true);
    ledger.close();
  });
});
