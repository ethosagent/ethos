// Per-room silence (plan channel-prompts L11, D20); shared setup in room-silence.fixtures.ts.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type { BackgroundJob, JobStore, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';
import type { RoomPolicyTable } from '../room-policy';
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
