// Per-room silence (plan channel-prompts L11, D20); shared setup in room-silence.fixtures.ts.

import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import { describe, expect, it } from 'vitest';
import { MessageDedupCache } from '../dedup';
import { ABSORBED_STEER_ACK, EMPTY_REPLY_NOTICE } from '../index';
import type { RoomPolicyTable } from '../room-policy';
import {
  couldBecomeSilentMarker,
  isSilentMarker,
  SILENT_REPLY_MARKERS,
  shouldSuppressSilentReply,
} from '../silent-reply';
import { DraftStreamer } from '../streaming';
import {
  gateway,
  loopYielding,
  msg,
  NOT_SILENT,
  recordingAdapter,
  replying,
  rows,
  SILENT,
  settle,
  silentEvents,
  waitUntil,
} from './room-silence.fixtures';

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
