// Per-room silence (plan channel-prompts L11, D20).
//
// A room that set `silent: true` may end a turn with exactly `NO_REPLY` (or
// `[SILENT]`) and the gateway sends nothing: no message, no empty-reply
// notice. The turn is still COMPLETE for every durability mechanism: no
// ledger obligation to resend, the spool row `done`, a wake review's row
// closed without its plain-notice fallback, no shutdown "please resend". A
// room that did not opt in delivers the marker as ordinary text. These tests
// drive real `SQLiteInboundSpool` / `SQLiteDeliveryLedger` files through real
// Gateways; a second Gateway on the same files is a restart.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { type SpoolRow, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type {
  BackgroundJob,
  DeliveryResult,
  InboundMessage,
  JobStore,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MessageDedupCache } from '../dedup';
import { ABSORBED_STEER_ACK, EMPTY_REPLY_NOTICE, Gateway, type GatewayConfig } from '../index';
import type { RoomPolicyTable } from '../room-policy';
import {
  couldBecomeSilentMarker,
  isSilentMarker,
  SILENT_REPLY_MARKERS,
  shouldSuppressSilentReply,
} from '../silent-reply';
import { DraftStreamer } from '../streaming';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

type Ev = { type: string; [k: string]: unknown };

/** An adapter that records sends and (when `edit`) edits. */
function recordingAdapter(opts: { edit?: boolean } = {}) {
  const sends: string[] = [];
  const edits: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: opts.edit === true,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    ...(opts.edit
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
  return { adapter, sends, edits };
}

/** A loop that replies with `events` on every turn. */
function loopYielding(events: Ev[] | (() => AsyncGenerator<Ev>)) {
  const run = vi.fn(() =>
    typeof events === 'function'
      ? events()
      : (async function* () {
          for (const e of events) yield e;
        })(),
  );
  return { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } };
}

/** A whole reply as one delta and a `done`. */
function replying(text: string): Ev[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', text, turnCount: 1 },
  ];
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'nightly digest tick',
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

const SILENT: RoomPolicyTable = { telegram: { entries: { 'chat-1': { silent: true } } } };
const NOT_SILENT: RoomPolicyTable = { telegram: { entries: { 'chat-1': { prompt: 'be brief' } } } };

function gateway(
  loop: unknown,
  adapter: PlatformAdapter,
  roomPolicies: RoomPolicyTable | undefined,
  extra: Partial<GatewayConfig> = {},
) {
  const events: Array<{ code: string; details?: Record<string, unknown> }> = [];
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    observability: {
      recordSafetyBlock: (e: { code: string }) => events.push(e),
    } as never,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    streamingEditIntervalMs: 0,
    ...(roomPolicies ? { roomPolicies } : {}),
    ...extra,
  });
  return { gw, events };
}

function rows(spool: SQLiteInboundSpool): SpoolRow[] {
  const db = (spool as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
  const ids = db.prepare('SELECT id FROM inbound_spool ORDER BY rowid').all() as Array<{
    id: string;
  }>;
  return ids.map(({ id }) => spool.get(id)).filter((r): r is SpoolRow => r !== null);
}

const silentEvents = <E extends { code: string }>(events: E[]): E[] =>
  events.filter((e) => e.code === 'gateway.silent_reply');

describe('silence markers (pure)', () => {
  it('the markers are exactly NO_REPLY and [SILENT]', () => {
    expect(SILENT_REPLY_MARKERS).toEqual(['NO_REPLY', '[SILENT]']);
  });

  it('isSilentMarker: exact after trim, case-sensitive, never a substring', () => {
    for (const yes of ['NO_REPLY', '[SILENT]', '  NO_REPLY\n', '\n[SILENT]  ', '\tNO_REPLY']) {
      expect(isSilentMarker(yes), JSON.stringify(yes)).toBe(true);
    }
    for (const no of [
      '',
      '   ',
      'NO_REPLY.',
      'no_reply',
      'No_Reply',
      '[silent]',
      'SILENT',
      'Sure. NO_REPLY',
      'NO_REPLY\nmore',
      'NO_REPLY NO_REPLY',
      'NO_REPL',
      '`NO_REPLY`',
    ]) {
      expect(isSilentMarker(no), JSON.stringify(no)).toBe(false);
    }
  });

  it('couldBecomeSilentMarker: true for every trimmed prefix, false once it diverges', () => {
    for (const marker of SILENT_REPLY_MARKERS) {
      for (let i = 0; i <= marker.length; i++) {
        expect(couldBecomeSilentMarker(marker.slice(0, i)), marker.slice(0, i)).toBe(true);
      }
    }
    for (const yes of ['', '  ', '\n NO_', 'NO_REPLY  \n', ' [SIL']) {
      expect(couldBecomeSilentMarker(yes), JSON.stringify(yes)).toBe(true);
    }
    for (const no of ['NO more', 'N0', 'no', 'NO_REPLY.', 'NO_REPLY\nmore', 'Hello', '[S]', 'x']) {
      expect(couldBecomeSilentMarker(no), JSON.stringify(no)).toBe(false);
    }
  });

  it('shouldSuppressSilentReply needs BOTH the room opt-in and a marker', () => {
    expect(shouldSuppressSilentReply(true, 'NO_REPLY')).toBe(true);
    expect(shouldSuppressSilentReply(true, ' [SILENT] ')).toBe(true);
    expect(shouldSuppressSilentReply(false, 'NO_REPLY')).toBe(false);
    expect(shouldSuppressSilentReply(false, '[SILENT]')).toBe(false);
    expect(shouldSuppressSilentReply(true, 'NO_REPLY.')).toBe(false);
    expect(shouldSuppressSilentReply(true, '')).toBe(false);
  });
});

describe('DraftStreamer silentHold (pure streamer)', () => {
  function streamer(silent: boolean | undefined) {
    const out = recordingAdapter({ edit: true });
    const s = new DraftStreamer({
      adapter: out.adapter,
      chatId: 'chat-1',
      threadId: undefined,
      sessionKey: 'sk',
      dedup: new MessageDedupCache(),
      minEditIntervalMs: 0,
      ...(silent === undefined ? {} : { silentHold: () => silent }),
    });
    return { s, ...out };
  }

  it('holds every prefix of a marker; nothing is ever posted', async () => {
    const { s, sends, edits } = streamer(true);
    for (const t of ['N', 'NO', 'NO_', 'NO_REP', 'NO_REPLY', 'NO_REPLY\n']) await s.pushText(t);
    expect(sends).toEqual([]);
    expect(edits).toEqual([]);
    expect(s.hasDelivered).toBe(false);
  });

  it('holds a progress line while there is no text yet', async () => {
    const { s, sends } = streamer(true);
    await s.pushProgress('reading the feed');
    expect(sends).toEqual([]);
    await s.pushText('[SILENT]');
    expect(sends).toEqual([]);
    expect(s.hasDelivered).toBe(false);
  });

  it('flushes the held text as the first message once it diverges, then edits normally', async () => {
    const { s, sends, edits } = streamer(true);
    await s.pushText('NO');
    await s.pushText('NO ');
    expect(sends).toEqual([]);
    await s.pushText('NO more');
    expect(sends).toEqual(['NO more']);
    await s.pushText('NO more tickets today');
    expect(edits).toEqual(['NO more tickets today']);
    await s.finalize('NO more tickets today.');
    expect(edits.at(-1)).toBe('NO more tickets today.');
  });

  it('without the option (or with it false) a marker prefix streams as today', async () => {
    for (const silent of [undefined, false]) {
      const { s, sends } = streamer(silent);
      await s.pushText('NO_');
      expect(sends).toEqual(['NO_']);
    }
  });
});

describe('silent room — the reply is dropped, the turn is complete', () => {
  for (const marker of ['NO_REPLY', '[SILENT]', '  NO_REPLY \n']) {
    it(`${JSON.stringify(marker)}: nothing sent, no notice, gateway.silent_reply recorded, ledger and spool settled`, async () => {
      const spool = new SQLiteInboundSpool(':memory:');
      const ledger = new SQLiteDeliveryLedger(':memory:');
      const out = recordingAdapter();
      const loop = loopYielding(replying(marker));
      const { gw, events } = gateway(loop, out.adapter, SILENT, {
        inboundSpool: spool,
        inboundSpoolOptions: { replayIntervalMs: 0 },
        deliveryLedger: ledger,
      });

      await gw.handleMessage(msg(), out.adapter);

      expect(out.adapter.send).not.toHaveBeenCalled();
      expect(out.sends).not.toContain(EMPTY_REPLY_NOTICE);
      expect(silentEvents(events)).toHaveLength(1);
      expect(silentEvents(events)[0]?.details).toMatchObject({
        platform: 'telegram',
        chatId: 'chat-1',
        botKey: 'bot-a',
      });
      expect(events.filter((e) => e.code === 'gateway.empty_reply')).toHaveLength(0);

      // Ledger: nothing is owed, so nothing was written and nothing is pending.
      const row = rows(spool)[0];
      expect(row).toMatchObject({ status: 'done', attempts: 1 });
      expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
      expect(await ledger.hasObligationFor(row?.id ?? '')).toBe(false);

      // The same process sweeping, then a restart on the same files: no resend,
      // no replay, no second model call.
      expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
      expect(await gw.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
      const rebooted = gateway(loop, out.adapter, SILENT, {
        inboundSpool: spool,
        inboundSpoolOptions: { replayIntervalMs: 0 },
        deliveryLedger: ledger,
      }).gw;
      expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
      expect(await rebooted.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
      await settle();
      expect(loop.run).toHaveBeenCalledTimes(1);
      expect(out.adapter.send).not.toHaveBeenCalled();
    });
  }

  it('a shutdown during the silent turn’s tail sends no "please resend" notice', async () => {
    const out = recordingAdapter();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((r) => {
      release = r;
    });
    const loop = loopYielding(async function* () {
      yield { type: 'text_delta', text: 'NO_REPLY' };
      yield { type: 'done', text: 'NO_REPLY', turnCount: 1 };
      await tail; // the turn-end tail (memory flush, compaction) still running
    });
    // Unspooled on purpose: a spooled turn never gets this notice (D19).
    const { gw, events } = gateway(loop, out.adapter, SILENT);

    const turn = gw.handleMessage(msg(), out.adapter).catch(() => {});
    await waitUntil(() => silentEvents(events).length === 1);
    await gw.shutdown({ notify: 'RESEND', drainTimeoutMs: 50 });
    release?.();
    await turn;

    expect(out.sends).toEqual([]);
  });

  it('a room that did NOT opt in delivers NO_REPLY as ordinary text', async () => {
    for (const table of [NOT_SILENT, undefined]) {
      const ledger = new SQLiteDeliveryLedger(':memory:');
      const out = recordingAdapter();
      const { gw, events } = gateway(loopYielding(replying('NO_REPLY')), out.adapter, table, {
        deliveryLedger: ledger,
      });
      await gw.handleMessage(msg(), out.adapter);
      expect(out.sends).toEqual(['NO_REPLY']);
      expect(silentEvents(events)).toHaveLength(0);
    }
  });

  it('silent: false on the room overrides a silent wildcard', async () => {
    const out = recordingAdapter();
    const table: RoomPolicyTable = {
      telegram: { entries: { '*': { silent: true }, 'chat-1': { silent: false } } },
    };
    const { gw } = gateway(loopYielding(replying('[SILENT]')), out.adapter, table);
    await gw.handleMessage(msg({ isDm: false, isGroupMention: true }), out.adapter);
    expect(out.sends).toEqual(['[SILENT]']);
  });

  for (const text of ['NO_REPLY.', 'NO_REPLY\nmore', 'Sure. NO_REPLY', 'no_reply', '[silent]']) {
    it(`${JSON.stringify(text)} in a silent room is sent: a marker is the whole reply or nothing`, async () => {
      const out = recordingAdapter();
      const { gw, events } = gateway(loopYielding(replying(text)), out.adapter, SILENT);
      await gw.handleMessage(msg(), out.adapter);
      expect(out.sends).toEqual([text]);
      expect(silentEvents(events)).toHaveLength(0);
    });
  }

  it('a turn that ERRORS in a silent room still notifies', async () => {
    const out = recordingAdapter();
    const { gw, events } = gateway(
      loopYielding([
        { type: 'text_delta', text: 'NO_REPLY' },
        { type: 'error', error: 'provider down', code: 'llm_error' },
      ]),
      out.adapter,
      SILENT,
    );
    await gw.handleMessage(msg(), out.adapter);
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).toContain('Response interrupted');
    expect(silentEvents(events)).toHaveLength(0);
  });

  it('a BLANK done in a silent room is still an empty reply, not a silent one', async () => {
    const out = recordingAdapter();
    const { gw, events } = gateway(
      loopYielding([{ type: 'done', text: '', turnCount: 1 }]),
      out.adapter,
      SILENT,
    );
    await gw.handleMessage(msg(), out.adapter);
    expect(out.sends).toEqual([EMPTY_REPLY_NOTICE]);
    expect(silentEvents(events)).toHaveLength(0);
  });
});

describe('silent room — marker plus a notice', () => {
  it('a halt notice after a marker answer is sent alone, without the literal marker', async () => {
    const out = recordingAdapter();
    const loop = loopYielding([
      { type: 'text_delta', text: 'NO_REPLY' },
      {
        type: 'halt',
        kind: 'budget',
        rule: 'max_turns',
        message: 'Stopped: turn budget reached.',
      },
      { type: 'done', text: 'NO_REPLY', turnCount: 1 },
    ]);
    const { gw } = gateway(loop, out.adapter, SILENT);
    await gw.handleMessage(msg(), out.adapter);
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).not.toContain('NO_REPLY');
    expect(out.sends[0]).toContain('Stopped');
  });
});

describe('silent room — acks', () => {
  /** A loop whose first turn parks until released; later turns reply `NO_REPLY` at once. */
  function parkedLoop() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const loop = loopYielding(() => {
      const first = n++ === 0;
      return (async function* () {
        if (first) await gate;
        for (const e of replying('NO_REPLY')) yield e;
      })();
    });
    return { loop, release };
  }

  async function secondWhileBusy(table: RoomPolicyTable, edit: boolean) {
    const out = recordingAdapter({ edit });
    const { loop, release } = parkedLoop();
    const { gw } = gateway(
      loop,
      out.adapter,
      table,
      edit ? { streamingEdits: { dm: true, group: true } } : {},
    );
    const first = gw.handleMessage(msg(), out.adapter);
    await settle();
    const second = gw.handleMessage(msg({ text: 'and another thing' }), out.adapter);
    await settle();
    release();
    await Promise.all([first, second]);
    await settle();
    return out.sends;
  }

  for (const edit of [false, true]) {
    it(`a message queued behind a running turn gets no ack in a silent room (edit=${edit})`, async () => {
      expect(await secondWhileBusy(SILENT, edit)).toEqual([]);
    });

    it(`control: the same message in a non-silent room is acked (edit=${edit})`, async () => {
      const sends = await secondWhileBusy(NOT_SILENT, edit);
      expect(sends.some((t) => t === ABSORBED_STEER_ACK || t.startsWith('⏳ queued'))).toBe(true);
    });
  }
});

describe('silent room — streaming lane', () => {
  it('"NO_" + "REPLY" never creates or edits a draft, and nothing is sent', async () => {
    const out = recordingAdapter({ edit: true });
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, events } = gateway(
      loopYielding([
        { type: 'text_delta', text: 'NO_' },
        { type: 'text_delta', text: 'REPLY' },
        { type: 'done', text: 'NO_REPLY', turnCount: 1 },
      ]),
      out.adapter,
      SILENT,
      { deliveryLedger: ledger },
    );
    await gw.handleMessage(msg(), out.adapter);
    await settle();
    expect(out.adapter.send).not.toHaveBeenCalled();
    expect(out.adapter.editMessage).not.toHaveBeenCalled();
    expect(silentEvents(events)).toHaveLength(1);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
  });

  it('a user-audience progress line before the marker posts no draft either', async () => {
    const out = recordingAdapter({ edit: true });
    const { gw } = gateway(
      loopYielding([
        { type: 'tool_progress', toolName: 'read_file', message: 'reading', audience: 'user' },
        { type: 'text_delta', text: '[SILENT]' },
        { type: 'done', text: '[SILENT]', turnCount: 1 },
      ]),
      out.adapter,
      SILENT,
    );
    await gw.handleMessage(msg(), out.adapter);
    await settle();
    expect(out.adapter.send).not.toHaveBeenCalled();
    expect(out.adapter.editMessage).not.toHaveBeenCalled();
  });

  it('"NO " + "more" streams once it diverges and lands the final', async () => {
    const out = recordingAdapter({ edit: true });
    const { gw, events } = gateway(
      loopYielding([
        { type: 'text_delta', text: 'NO ' },
        { type: 'text_delta', text: 'more' },
        { type: 'text_delta', text: ' alerts.' },
        { type: 'done', text: 'NO more alerts.', turnCount: 1 },
      ]),
      out.adapter,
      SILENT,
    );
    await gw.handleMessage(msg(), out.adapter);
    await settle();
    // The held "NO " was never posted; the first message is the diverged text.
    expect(out.sends).toEqual(['NO more']);
    expect(out.edits.at(-1)).toBe('NO more alerts.');
    expect(silentEvents(events)).toHaveLength(0);
  });

  it('a non-silent streaming lane streams "NO_" as today (unchanged)', async () => {
    const out = recordingAdapter({ edit: true });
    const { gw } = gateway(
      loopYielding([
        { type: 'text_delta', text: 'NO_' },
        { type: 'text_delta', text: 'REPLY' },
        { type: 'done', text: 'NO_REPLY', turnCount: 1 },
      ]),
      out.adapter,
      NOT_SILENT,
    );
    await gw.handleMessage(msg(), out.adapter);
    await settle();
    expect(out.sends).toEqual(['NO_']);
    expect(out.edits.at(-1)).toBe('NO_REPLY');
  });
});

describe('silent room — spool replay', () => {
  it('a replayed turn that answers NO_REPLY sends nothing and closes its row', async () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const out = recordingAdapter();
    // The first process never finishes its turn (a kill -9 analogue).
    const first = loopYielding(async function* () {
      await new Promise(() => {});
    });
    const opts = {
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
      deliveryLedger: ledger,
    };
    void gateway(first, out.adapter, SILENT, opts).gw.handleMessage(msg(), out.adapter);
    await waitUntil(() => first.run.mock.calls.length === 1);
    expect(rows(spool)[0]).toMatchObject({ status: 'processing' });

    const second = loopYielding(replying('NO_REPLY'));
    const { gw: gw2, events } = gateway(second, out.adapter, SILENT, opts);
    expect(await gw2.replayInboundSpool()).toEqual({ replayed: 1, deferred: 0, dead: 0 });
    await waitUntil(() => rows(spool)[0]?.status === 'done');

    expect(out.adapter.send).not.toHaveBeenCalled();
    expect(silentEvents(events)).toHaveLength(1);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
    expect(await gw2.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
    expect(await gw2.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
    expect(second.run).toHaveBeenCalledTimes(1);
  });
});

describe('silent room — wake review', () => {
  function job(): BackgroundJob {
    return {
      id: 'job-1234abcd',
      owner: 'proc-1',
      parentSessionKey: 'telegram:bot-a:chat-1',
      rootSessionKey: 'telegram:bot-a:chat-1',
      childSessionKey: 'child',
      depth: 1,
      status: 'done',
      prompt: 'check the build',
      summary: 'CI run 812: all tests passed',
      spendUsd: 0,
      createdAt: Date.now(),
      originPlatform: 'telegram',
      originBotKey: 'bot-a',
      originChatId: 'chat-1',
      deliver: 'parent',
    };
  }

  function fakeJobStore(jobs: BackgroundJob[]) {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return {
      get: async (id: string) => byId.get(id) ?? null,
      claimDelivery: vi.fn(async (id: string) => {
        const j = byId.get(id);
        if (!j || j.deliveredAt !== undefined) return false;
        j.deliveredAt = Date.now();
        return true;
      }),
      releaseDelivery: async (id: string) => {
        const j = byId.get(id);
        if (j) j.deliveredAt = undefined;
      },
      listUndelivered: async (botKeys: string[]) =>
        [...byId.values()].filter(
          (j) => j.deliveredAt === undefined && botKeys.includes(j.originBotKey ?? ''),
        ),
    } as unknown as JobStore;
  }

  function reviewGateway(loop: unknown, adapter: PlatformAdapter, table: RoomPolicyTable) {
    const spool = new SQLiteInboundSpool(':memory:');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const j = job();
    const store = fakeJobStore([j]);
    const handlers: Array<(j: BackgroundJob) => void> = [];
    const executor = {
      owner: 'proc-1',
      nudge: vi.fn(),
      onComplete: (h: (j: BackgroundJob) => void) => {
        handlers.push(h);
        return () => {};
      },
    };
    const events: Array<{ code: string }> = [];
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: loop as AgentLoop,
          binding: { type: 'personality', name: 'default' },
          jobStore: store,
          backgroundExecutor: executor as never,
        },
      ],
      adapters: new Map([['telegram', adapter]]),
      inboundSpool: spool,
      inboundSpoolOptions: { replayIntervalMs: 0 },
      deliveryLedger: ledger,
      observability: { recordSafetyBlock: (e: { code: string }) => events.push(e) } as never,
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
      roomPolicies: table,
    });
    const fire = (): void => {
      for (const h of handlers) h(j);
    };
    return { gw, spool, ledger, j, store, events, fire };
  }

  it('a review that answers NO_REPLY sends nothing, no plain-notice fallback, and settles', async () => {
    const out = recordingAdapter();
    const loop = loopYielding(replying('NO_REPLY'));
    const r = reviewGateway(loop, out.adapter, SILENT);
    r.fire();
    await waitUntil(() => rows(r.spool)[0]?.status === 'done');
    await settle();

    expect(out.adapter.send).not.toHaveBeenCalled();
    expect(silentEvents(r.events)).toHaveLength(1);
    expect(r.events.filter((e) => e.code === 'gateway.review_fallback')).toHaveLength(0);
    // The job's delivery claim stays taken: nothing re-owes it.
    expect(r.j.deliveredAt).toBeGreaterThan(0);
    expect(await r.store.listUndelivered(['bot-a'])).toHaveLength(0);
    expect(rows(r.spool)[0]).toMatchObject({ kind: 'wake_review', status: 'done' });
    expect(await r.ledger.listPending(['bot-a'])).toHaveLength(0);
    expect(await r.gw.replayInboundSpool()).toEqual({ replayed: 0, deferred: 0, dead: 0 });
    expect(await r.gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
    expect(loop.run).toHaveBeenCalledTimes(1);
    expect(out.adapter.send).not.toHaveBeenCalled();
  });

  it('a review that answers NO_REPLY in a room that did not opt in delivers it as text', async () => {
    const out = recordingAdapter();
    const r = reviewGateway(loopYielding(replying('NO_REPLY')), out.adapter, NOT_SILENT);
    r.fire();
    await waitUntil(() => rows(r.spool)[0]?.status === 'done');
    expect(out.sends).toEqual(['NO_REPLY']);
  });
});

describe('silent room — adapter.endTurn', () => {
  const withEndTurn = (out: ReturnType<typeof recordingAdapter>, impl?: () => Promise<void>) => {
    const endTurn = vi.fn(impl ?? (async () => {}));
    Object.assign(out.adapter, { endTurn });
    return endTurn;
  };

  it('a silent turn calls endTurn once, with the chat and no thread', async () => {
    const out = recordingAdapter();
    const endTurn = withEndTurn(out);
    const { gw } = gateway(loopYielding(replying('NO_REPLY')), out.adapter, SILENT);
    await gw.handleMessage(msg(), out.adapter);
    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(endTurn).toHaveBeenCalledWith('chat-1', {});
    expect(out.adapter.send).not.toHaveBeenCalled();
  });

  it('passes the thread id through', async () => {
    const out = recordingAdapter();
    const endTurn = withEndTurn(out);
    const { gw } = gateway(loopYielding(replying('NO_REPLY')), out.adapter, SILENT);
    await gw.handleMessage(msg({ threadId: 't-9' }), out.adapter);
    expect(endTurn).toHaveBeenCalledWith('chat-1', { threadId: 't-9' });
  });

  it('a throwing endTurn is swallowed: still silent, still complete', async () => {
    const out = recordingAdapter();
    const endTurn = withEndTurn(out, async () => {
      throw new Error('boom');
    });
    const { gw, events } = gateway(loopYielding(replying('NO_REPLY')), out.adapter, SILENT);
    await gw.handleMessage(msg(), out.adapter);
    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(silentEvents(events)).toHaveLength(1);
    expect(out.adapter.send).not.toHaveBeenCalled();
  });

  it('a room that did not opt in never calls endTurn from this path', async () => {
    const out = recordingAdapter();
    const endTurn = withEndTurn(out);
    const { gw } = gateway(loopYielding(replying('NO_REPLY')), out.adapter, NOT_SILENT);
    await gw.handleMessage(msg(), out.adapter);
    expect(endTurn).not.toHaveBeenCalled();
    expect(out.sends).toEqual(['NO_REPLY']);
  });

  it('a silent room with an ordinary reply never calls endTurn', async () => {
    const out = recordingAdapter();
    const endTurn = withEndTurn(out);
    const { gw } = gateway(loopYielding(replying('hello there')), out.adapter, SILENT);
    await gw.handleMessage(msg(), out.adapter);
    expect(endTurn).not.toHaveBeenCalled();
    expect(out.sends).toEqual(['hello there']);
  });
});
