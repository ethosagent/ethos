// `Gateway.notifyTracked` — the public door onto the delivery ledger.
//
// The post-call summary and the owner's "a call was refused for capacity"
// notice have nobody waiting on them, so "the send silently failed" is the
// failure mode that matters (voice V4: "so a summary is never silently lost").
// `sendTo()` cannot serve them: it records no obligation. `sendTracked()` could,
// but it was private.
//
// The property under test is the ledger's, not the API's: an unconfirmed send
// leaves a `pending` row that the boot sweep redelivers. Same definition of
// confirmed as every other covered path — `DeliveryResult.ok === true`.

import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Gateway,
  type GatewayBotConfig,
  type GatewayConfig,
  type HeldNotice,
  type HeldNoticeStore,
} from '../index';

function stubAdapter(opts: { ok?: boolean } = {}) {
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, message: OutboundMessage): Promise<DeliveryResult> => {
      sent.push({ chatId, message });
      return opts.ok === false
        ? { ok: false, error: 'platform rejected the message' }
        : { ok: true, messageId: String(nextId++) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent });
}

function stubLoop(): AgentLoop {
  return {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: '', turnCount: 1 };
    }),
    hooks: new DefaultHookRegistry(),
  } as unknown as AgentLoop;
}

function gatewayWith(opts: {
  ledger?: SQLiteDeliveryLedger;
  adapters?: Map<string, PlatformAdapter>;
  botKeys?: string[];
  observability?: { recordSafetyBlock: (e: { code: string; cause: string }) => void };
  extra?: Partial<GatewayConfig>;
}) {
  return new Gateway({
    ...opts.extra,
    bots: (opts.botKeys ?? ['bot-a']).map((botKey) => ({
      botKey,
      loop: stubLoop(),
      binding: { type: 'personality' as const, name: 'default' },
    })),
    ...(opts.ledger ? { deliveryLedger: opts.ledger } : {}),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.observability ? { observability: opts.observability as unknown as never } : {}),
    clarifySweepIntervalMs: 0,
  });
}

const TARGET = { platform: 'telegram', chatId: 'C1' };

describe('Gateway.notifyTracked', () => {
  it('confirms a delivered notice and leaves no obligation behind', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = stubAdapter();
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', adapter]]) });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(true);

    expect(adapter.sent.map((s) => s.message.text)).toEqual(['call summary']);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
  });

  // The whole reason this method exists.
  it('a failing adapter leaves the row pending and the boot sweep redelivers it', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', failing]]) });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(false);

    const pending = await ledger.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.content).toBe('call summary');

    // Next boot: the adapter is healthy again.
    const healthy = stubAdapter();
    const rebooted = gatewayWith({ ledger, adapters: new Map([['telegram', healthy]]) });
    expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.sent.map((s) => s.message.text)).toEqual(['call summary']);
  });

  it('a throwing adapter is treated exactly like { ok: false }', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const thrower = stubAdapter();
    vi.mocked(thrower.send).mockRejectedValue(new Error('socket hangup'));
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', thrower]]) });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(false);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(1);
  });

  // A reply belongs to the sub-conversation it answered, and a redelivery has
  // to return there rather than to the root chat.
  it('carries the threadId onto both the platform call and the obligation', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', failing]]) });

    await gw.notifyTracked({ ...TARGET, threadId: 'T-9' }, 'call summary');

    expect(failing.sent[0]?.message.threadId).toBe('T-9');
    expect((await ledger.listPending(['bot-a']))[0]?.threadId).toBe('T-9');
  });

  it('returns false and records the unconfirmed event when no adapter serves the platform', async () => {
    const blocks: Array<{ code: string; cause: string }> = [];
    const gw = gatewayWith({
      ledger: new SQLiteDeliveryLedger(':memory:'),
      adapters: new Map(),
      observability: { recordSafetyBlock: (e) => blocks.push(e) },
    });

    await expect(gw.notifyTracked({ platform: 'discord', chatId: 'C1' }, 'x')).resolves.toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('gateway.delivery_unconfirmed');
    expect(blocks[0]?.cause).toContain('no adapter registered');
  });

  // An obligation filed under a botKey this process does not own is one the
  // sweep never picks up — a lost message wearing a durable row.
  it('refuses a botKey this process does not serve', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = stubAdapter();
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', adapter]]) });

    await expect(gw.notifyTracked({ ...TARGET, botKey: 'bot-elsewhere' }, 'x')).resolves.toBe(
      false,
    );
    expect(adapter.sent).toHaveLength(0);
    expect(await ledger.listPending(['bot-elsewhere'])).toHaveLength(0);
  });

  it('requires an explicit botKey in a multi-bot deployment', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    // Bot B's own adapter: a tracked send leaves through the named bot's
    // adapter, never the platform's default (F08).
    const adapter = Object.assign(stubAdapter(), { id: 'telegram:bot-b' });
    const gw = gatewayWith({
      ledger,
      adapters: new Map([['telegram', adapter]]),
      botKeys: ['bot-a', 'bot-b'],
    });

    await expect(gw.notifyTracked(TARGET, 'x')).resolves.toBe(false);
    await expect(gw.notifyTracked({ ...TARGET, botKey: 'bot-b' }, 'x')).resolves.toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });

  it('works with no ledger wired — the send still happens, just without a row', async () => {
    const adapter = stubAdapter();
    const gw = gatewayWith({ adapters: new Map([['telegram', adapter]]) });
    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// U11 (openclaw-9.6-gaps) — quiet hours and per-lane /mute. A notice nobody
// asked for is HELD inside the window (in the held-notice store, notify-queue in
// production) and released through the ledger-backed path once the window ends.
// Never dropped; a reply to the user's own message is never held.
// ---------------------------------------------------------------------------

class MemoryHeldNotices implements HeldNoticeStore {
  rows: HeldNotice[] = [];
  private seq = 0;
  async hold(notice: Omit<HeldNotice, 'id' | 'heldAt'>): Promise<void> {
    this.rows.push({ ...notice, id: ++this.seq, heldAt: Date.now() });
  }
  async listHeld(): Promise<HeldNotice[]> {
    return [...this.rows];
  }
  async markReleased(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

// 22:00–07:00 in UTC, so the test does not depend on the host's zone.
const QUIET = {
  timeZone: 'UTC',
  window: { startMinute: 22 * 60, endMinute: 7 * 60 },
};

describe('Gateway.notifyTracked — quiet hours (U11)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a notice inside quiet hours and delivers it through the ledger once the window ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const held = new MemoryHeldNotices();
    const adapter = stubAdapter();
    const gw = gatewayWith({
      ledger,
      adapters: new Map([['telegram', adapter]]),
      extra: { quietHours: QUIET, heldNotices: held },
    });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(false);
    expect(adapter.sent).toHaveLength(0);
    expect(held.rows.map((r) => r.text)).toEqual(['call summary']);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);

    // Still inside the window: the sweep leaves it held.
    await gw.sweepPendingDeliveries();
    expect(adapter.sent).toHaveLength(0);

    vi.setSystemTime(new Date('2026-09-26T07:01:00Z'));
    await gw.sweepPendingDeliveries();
    expect(adapter.sent.map((s) => s.message.text)).toEqual(['call summary']);
    expect(held.rows).toHaveLength(0);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
  });

  it('never holds a notice that answers the user’s own message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    const held = new MemoryHeldNotices();
    const adapter = stubAdapter();
    const gw = gatewayWith({
      adapters: new Map([['telegram', adapter]]),
      extra: { quietHours: QUIET, heldNotices: held },
    });

    await expect(
      gw.notifyTracked({ ...TARGET, answersInbound: true }, 'please resend'),
    ).resolves.toBe(true);
    expect(adapter.sent).toHaveLength(1);
    expect(held.rows).toHaveLength(0);
  });

  it('sends immediately when no held-notice store is wired — never dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    const adapter = stubAdapter();
    const gw = gatewayWith({
      adapters: new Map([['telegram', adapter]]),
      extra: { quietHours: QUIET },
    });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });

  it('a per-bot override of null turns quiet hours off for that bot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    const held = new MemoryHeldNotices();
    const adapter = stubAdapter();
    const gw = gatewayWith({
      adapters: new Map([['telegram', adapter]]),
      extra: { quietHours: { ...QUIET, byBot: { 'bot-a': null } }, heldNotices: held },
    });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(true);
    expect(held.rows).toHaveLength(0);
  });

  it('/mute <duration> holds this lane’s notices outside quiet hours; /mute off releases them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const held = new MemoryHeldNotices();
    const adapter = stubAdapter();
    const gw = gatewayWith({
      ledger: new SQLiteDeliveryLedger(':memory:'),
      adapters: new Map([['telegram', adapter]]),
      extra: { heldNotices: held },
    });
    const inbound = (text: string, messageId: string) => ({
      platform: 'telegram',
      chatId: 'C1',
      userId: 'u1',
      botKey: 'bot-a',
      text,
      isDm: true,
      isGroupMention: false,
      messageId,
      raw: {},
    });

    await gw.handleMessage(inbound('/mute 2h', 'm1'), adapter);
    expect(adapter.sent.at(-1)?.message.text).toMatch(/muted/i);
    const acks = adapter.sent.length;

    await expect(gw.notifyTracked(TARGET, 'job finished')).resolves.toBe(false);
    expect(held.rows.map((r) => r.text)).toEqual(['job finished']);

    await gw.handleMessage(inbound('/mute off', 'm2'), adapter);
    await gw.sweepPendingDeliveries();
    expect(adapter.sent.slice(acks).map((s) => s.message.text)).toContain('job finished');
    expect(held.rows).toHaveLength(0);
  });

  it('holds a background-job wake notice inside quiet hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T23:30:00Z'));
    const held = new MemoryHeldNotices();
    const adapter = stubAdapter();
    const job = {
      id: 'job-quiet-1',
      owner: 'p',
      parentSessionKey: 'parent',
      rootSessionKey: 'root',
      childSessionKey: 'child',
      depth: 1,
      status: 'done' as const,
      prompt: 'p',
      summary: 'did it',
      spendUsd: 0,
      createdAt: Date.now(),
      originPlatform: 'telegram',
      originBotKey: 'bot-a',
      originChatId: 'C1',
    };
    let delivered = false;
    const jobStore = {
      listUndelivered: async () => (delivered ? [] : [job]),
      claimDelivery: async () => {
        delivered = true;
        return true;
      },
      releaseDelivery: async () => {
        delivered = false;
      },
    };
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: stubLoop(),
          binding: { type: 'personality' as const, name: 'default' },
          jobStore: jobStore as unknown as NonNullable<GatewayBotConfig['jobStore']>,
        },
      ],
      adapters: new Map([['telegram', adapter]]),
      quietHours: QUIET,
      heldNotices: held,
      clarifySweepIntervalMs: 0,
    });

    await gw.sweepUndeliveredJobs();
    expect(adapter.sent).toHaveLength(0);
    expect(held.rows).toHaveLength(1);
    expect(held.rows[0]?.text).toContain('did it');
  });
});
