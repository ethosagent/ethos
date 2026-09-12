// F06 (plan/phases/architecture-suggestions-2026-09-10.md) — `createWebApi`
// owns what it starts and nothing it borrows. Before this it started a
// `DashboardRefreshScheduler` and dropped the handle (`unref()` does not clear
// an interval), so a host that stopped and rebuilt its runtime in one process
// — the desktop's restart — kept every earlier scheduler ticking against a
// loop that no longer served anyone.
//
// Only `setInterval` is faked: the scheduler's tick is an interval, and no
// other interval is started by construction alone (SSE keep-alives start per
// connection).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  type AgentLoop,
  ClarifyBridge,
  ClarifyNoSurfaceError,
  type ClarifyPresenter,
  DefaultHookRegistry,
  DefaultToolRegistry,
  FileClarifyStore,
} from '@ethosagent/core';
import { DashboardRefreshScheduler, DashboardsService } from '@ethosagent/dashboard';
import { SQLiteCardStore } from '@ethosagent/session-cards';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { HookRegistry, PendingClarify } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../index';
import { CallsService } from '../services/calls.service';
import { DeliveriesService } from '../services/deliveries.service';
import { ObservedChatsService } from '../services/observed-chats.service';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from './test-helpers';

let dir: string;
let session: SQLiteSessionStore;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-dispose-'));
  session = new SQLiteSessionStore(':memory:');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  session.close();
  await rm(dir, { recursive: true, force: true });
});

function build(overrides: Partial<Parameters<typeof createWebApi>[0]> = {}) {
  return createWebApi({
    dataDir: dir,
    sessionStore: session,
    memoryBundle: makeStubMemoryBundle(),
    agentLoop: makeStubAgentLoop(),
    personalities: makeStubPersonalityRegistry(),
    chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    ...overrides,
  });
}

/** Wrap every `register*` on a borrowed hook registry so the test can see
 *  whether each registration's cleanup was run. */
function trackRegistrations(hooks: HookRegistry): Array<ReturnType<typeof vi.fn>> {
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  for (const method of ['registerVoid', 'registerModifying', 'registerClaiming'] as const) {
    const original = hooks[method].bind(hooks) as (...args: unknown[]) => () => void;
    vi.spyOn(hooks, method).mockImplementation(((...args: unknown[]) => {
      const cleanup = vi.fn(original(...args));
      cleanups.push(cleanup);
      return cleanup;
    }) as never);
  }
  return cleanups;
}

describe('createWebApi owns its runtime, never a borrowed one (F06)', () => {
  it('dispose() stops the dashboard refresh scheduler it started', async () => {
    const stop = vi.spyOn(DashboardRefreshScheduler.prototype, 'stop');
    const created = build();
    expect(vi.getTimerCount()).toBe(1);

    await created.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // Idempotent.
    await created.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('start-stop-start leaves exactly one scheduler timer', async () => {
    const first = build();
    await first.dispose();
    const second = build();
    expect(vi.getTimerCount()).toBe(1);
    await second.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases what it registered on borrowed services and closes only the stores it opened', async () => {
    const loop = makeStubAgentLoop();
    const cleanups = trackRegistrations(loop.hooks);
    const toolRegistry = new DefaultToolRegistry();
    const cardsClose = vi.spyOn(SQLiteCardStore.prototype, 'close');
    const dashboardsClose = vi.spyOn(DashboardsService.prototype, 'close');
    const borrowedSessionClose = vi.spyOn(session, 'close');
    const created = build({
      agentLoop: loop,
      toolRegistry,
      // With a predicate the web approval hook is registered too.
      dangerPredicate: async () => null,
    });
    const dashboardTools = toolRegistry
      .getAvailable()
      .filter((t) => t.name.startsWith('dashboard'));
    expect(dashboardTools.length).toBeGreaterThan(0);
    expect(cleanups.length).toBeGreaterThan(0);

    await created.dispose();

    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
    expect(toolRegistry.getAvailable().filter((t) => t.name.startsWith('dashboard'))).toEqual([]);
    expect(cardsClose).toHaveBeenCalledTimes(1);
    expect(dashboardsClose).toHaveBeenCalledTimes(1);
    // Borrowed: the host's session store stays open for the host to close.
    expect(borrowedSessionClose).not.toHaveBeenCalled();
    await expect(session.listSessions({ limit: 1 })).resolves.toBeDefined();
  });

  it('attempts every release even when one throws, then rejects with an AggregateError', async () => {
    vi.spyOn(SQLiteCardStore.prototype, 'close').mockImplementation(() => {
      throw new Error('cards.db busy');
    });
    const stop = vi.spyOn(DashboardRefreshScheduler.prototype, 'stop');
    const dashboardsClose = vi.spyOn(DashboardsService.prototype, 'close');
    const created = build();

    const err = await created.dispose().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('cards.db busy');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dashboardsClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a construction that throws partway releases what it had already opened', async () => {
    const loop = makeStubAgentLoop();
    const cleanups = trackRegistrations(loop.hooks);
    const cardsClose = vi.spyOn(SQLiteCardStore.prototype, 'close');
    const dashboardsClose = vi.spyOn(DashboardsService.prototype, 'close');

    // `onMemoryCaptured` is called late in construction — cards.db and
    // dashboards.db are open and hooks sit on the borrowed loop by then.
    expect(() =>
      build({
        agentLoop: loop,
        onMemoryCaptured: () => {
          throw new Error('capture feed unavailable');
        },
      }),
    ).toThrow('capture feed unavailable');
    await new Promise((r) => setTimeout(r, 0));

    expect(cleanups.length).toBeGreaterThan(0);
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cardsClose).toHaveBeenCalledTimes(1);
    expect(dashboardsClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // F06 follow-up (recursive -wal audit) — three read-side services open a
  // SQLite handle lazily and cache it for the life of the process
  // (delivery-ledger.db, calls.db, channel-transcript.db). Nothing closed them,
  // so each left a -wal/-shm pair behind once a page had been read.
  it('closes the read-side stores its services opened', async () => {
    const deliveries = vi.spyOn(DeliveriesService.prototype, 'close');
    const calls = vi.spyOn(CallsService.prototype, 'close');
    const observed = vi.spyOn(ObservedChatsService.prototype, 'close');
    const created = build();
    await created.dispose();
    expect(deliveries).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('aborts the chat turns it started and waits for them before resolving', async () => {
    const log = { finished: false };
    const loop = {
      hooks: new DefaultHookRegistry(),
      async *run(_input: string, opts: { abortSignal: AbortSignal }): AsyncGenerator<AgentEvent> {
        await new Promise<void>((resolve) => {
          if (opts.abortSignal.aborted) return resolve();
          opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        log.finished = true;
        yield { type: 'error', error: 'Aborted', code: 'aborted' };
      },
    } as unknown as AgentLoop;
    const created = build({ agentLoop: loop });
    await created.chatService.send({ clientId: 'tab', text: 'long task' });
    expect(created.chatService.hasActiveBridges()).toBe(true);

    await created.dispose();

    // The turn unwound BEFORE dispose resolved — so a host may dispose the
    // loop next without a turn still running on it.
    expect(log.finished).toBe(true);
    expect(created.chatService.hasActiveBridges()).toBe(false);
    await expect(created.chatService.send({ clientId: 'tab', text: 'late' })).rejects.toThrow(
      /shutting down/,
    );
  });

  // The loop's skill-evolution setters are single-slot: the next web API's
  // registration overwrites them, so there is nothing to unregister. The clarify
  // presenter IS released on dispose (see the test below) — this one covers the
  // other half: the disposed surface's callback must be inert if it is invoked
  // anyway, in the window before an overwrite or by a caller holding a stale
  // reference.
  it('start-stop-start: a disposed surface’s single-slot callbacks never reach it', async () => {
    const clarifyBridge = new ClarifyBridge(
      new FileClarifyStore(new InMemoryStorage(), '/clarify'),
    );
    const presenters: ClarifyPresenter[] = [];
    const register = clarifyBridge.registerPresenter.bind(clarifyBridge);
    vi.spyOn(clarifyBridge, 'registerPresenter').mockImplementation((surface, presenter) => {
      presenters.push(presenter);
      return register(surface, presenter);
    });
    let skillSlot: ((skillId: string, personalityId: string) => void) | undefined;
    const loop = Object.assign(makeStubAgentLoop(), { clarifyBridge }) as unknown as AgentLoop;
    const surface = () =>
      build({
        agentLoop: loop,
        setOnSkillProposed: (fn) => {
          skillSlot = fn;
        },
      });
    const row = {
      requestId: 'r1',
      sessionId: 's1',
      surfaceType: 'web',
      surfaceContext: {},
      question: 'which one?',
      answerableBy: 'anyone',
      createdAt: new Date().toISOString(),
      defaultDeadlineAt: null,
    } as unknown as PendingClarify;

    const a = surface();
    const aBroadcast = vi.spyOn(a.chatService, 'broadcast');
    const aBroadcastAll = vi.spyOn(a.chatService, 'broadcastAll');
    await a.dispose();

    // The window: A is disposed, B not yet built — A's callbacks are inert.
    await presenters[0]?.(row);
    skillSlot?.('skill-1', 'p1');
    expect(aBroadcast).not.toHaveBeenCalled();
    expect(aBroadcastAll).not.toHaveBeenCalled();

    const b = surface();
    const bBroadcast = vi.spyOn(b.chatService, 'broadcast');
    const bBroadcastAll = vi.spyOn(b.chatService, 'broadcastAll');
    await presenters[1]?.(row);
    skillSlot?.('skill-1', 'p1');
    // Only B hears it.
    expect(bBroadcast).toHaveBeenCalledTimes(1);
    expect(bBroadcastAll).toHaveBeenCalledTimes(1);
    expect(aBroadcast).not.toHaveBeenCalled();
    await b.dispose();
  });

  // A presenter left registered by a disposed surface is a black hole: routing
  // finds it, the bridge believes the question was asked, and nobody sees it.
  // `dispose`'s doc promises every clarify-bridge registration comes back.
  it('dispose releases the web clarify presenter — the bridge refuses as if none had registered', async () => {
    const clarifyBridge = new ClarifyBridge(
      new FileClarifyStore(new InMemoryStorage(), '/clarify'),
    );
    const loop = Object.assign(makeStubAgentLoop(), { clarifyBridge }) as unknown as AgentLoop;
    const ask = () =>
      clarifyBridge.request({
        question: 'which one?',
        timeoutMs: 1_000,
        answerableBy: 'anyone',
        sessionId: 's1',
        surfaceType: 'web',
      });

    const created = build({ agentLoop: loop });
    await created.dispose();

    await expect(ask()).rejects.toBeInstanceOf(ClarifyNoSurfaceError);

    // start-stop-start: the next surface takes the slot cleanly.
    const next = build({ agentLoop: loop });
    const broadcast = vi.spyOn(next.chatService, 'broadcast');
    const pending = ask().catch(() => undefined);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    await next.dispose();
    await pending;
  });
});
