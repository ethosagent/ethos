// S5 (plan openclaw-2026.9.6-gaps): watcher tools are scoped to the calling
// personality the way cron's are (`loadOwnedJob` in `@ethosagent/tools-cron`).
// A wake is always self, another personality's watcher is indistinguishable
// from a nonexistent one, and an ungated owner's `deliver` meets the same
// allowlist `send_message` does.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { WatcherManager, type WatcherWakeEvent } from '@ethosagent/watchers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWatcherTools, type WatcherOutboxGate } from '../index';

function ctxFor(personalityId: string | undefined): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    ...(personalityId !== undefined ? { personalityId } : {}),
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

let manager: WatcherManager;

function toolsFor(opts: Parameters<typeof createWatcherTools>[1] = {}): Map<string, Tool> {
  return new Map(createWatcherTools(manager, opts).map((t) => [t.name, t]));
}

async function run(
  name: string,
  args: Record<string, unknown>,
  personalityId: string | undefined,
  opts: Parameters<typeof createWatcherTools>[1] = {},
): Promise<ToolResult> {
  const tool = toolsFor(opts).get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args, ctxFor(personalityId));
}

function errorOf(r: ToolResult): string {
  if (r.ok) throw new Error(`expected refusal, got ok: ${r.value}`);
  return r.error;
}

const base = { kind: 'file', target: '/logs/app.log', interval_seconds: 60 };

async function seedAWatcher(): Promise<void> {
  const r = await run(
    'watcher_create',
    { id: 'a-log', ...base, wake: { personality_id: 'A' } },
    'A',
  );
  if (!r.ok) throw new Error(r.error);
}

beforeEach(() => {
  manager = new WatcherManager({ storage: new InMemoryStorage(), watchersDir: '/ethos/watchers' });
});

describe('watcher tool ownership', () => {
  it('refuses a wake naming another personality, and stores nothing', async () => {
    const r = await run(
      'watcher_create',
      { id: 'b-wakes-a', ...base, wake: { personality_id: 'A', prompt_prefix: 'do A things' } },
      'B',
    );
    expect(errorOf(r)).toBe(
      'wake.personality_id must be the calling personality ("B") — a watcher can only wake the personality that created it',
    );
    expect(await manager.getWatcher('b-wakes-a')).toBeNull();
  });

  it('allows a wake naming the caller', async () => {
    await seedAWatcher();
    expect((await manager.getWatcher('a-log'))?.onChange.wake?.personalityId).toBe('A');
  });

  it("B's list does not show A's watcher; A's does", async () => {
    await seedAWatcher();
    const listB = await run('watcher_list', {}, 'B');
    expect(listB).toEqual({ ok: true, value: 'No watchers configured.' });
    const listA = await run('watcher_list', {}, 'A');
    expect(listA.ok && listA.value).toContain('a-log');
  });

  it("B's pause/resume/delete on A's watcher return the same text as a nonexistent id", async () => {
    await seedAWatcher();
    const before = await manager.getWatcher('a-log');

    const onA: ToolResult[] = [];
    for (const name of ['watcher_pause', 'watcher_resume', 'watcher_delete']) {
      const r = await run(name, { id: 'a-log' }, 'B');
      expect(errorOf(r)).toBe('Watcher not found: a-log');
      onA.push(r);
    }
    expect(await manager.getWatcher('a-log')).toEqual(before);

    await manager.removeWatcher('a-log');
    const onNothing: ToolResult[] = [];
    for (const name of ['watcher_pause', 'watcher_resume', 'watcher_delete']) {
      onNothing.push(await run(name, { id: 'a-log' }, 'B'));
    }
    expect(onA).toEqual(onNothing);
  });

  it('A can still pause, resume and delete its own watcher', async () => {
    await seedAWatcher();
    expect((await run('watcher_pause', { id: 'a-log' }, 'A')).ok).toBe(true);
    expect((await run('watcher_resume', { id: 'a-log' }, 'A')).ok).toBe(true);
    expect((await run('watcher_delete', { id: 'a-log' }, 'A')).ok).toBe(true);
    expect(await manager.getWatcher('a-log')).toBeNull();
  });

  it('a record with no owner is not reachable from any personality', async () => {
    await manager.createWatcher({
      id: 'legacy',
      kind: 'file',
      target: '/logs/app.log',
      intervalSeconds: 60,
      onChange: { deliver: { platform: 'telegram', chatId: '1' } },
    });
    expect(errorOf(await run('watcher_delete', { id: 'legacy' }, 'A'))).toBe(
      'Watcher not found: legacy',
    );
    expect(await run('watcher_list', {}, 'A')).toEqual({
      ok: true,
      value: 'No watchers configured.',
    });
  });

  it('a call with no personality context is refused for every tool', async () => {
    await seedAWatcher();
    for (const [name, args] of [
      ['watcher_create', { id: 'x', ...base, deliver: { platform: 'telegram', chat_id: '1' } }],
      ['watcher_list', {}],
      ['watcher_pause', { id: 'a-log' }],
      ['watcher_resume', { id: 'a-log' }],
      ['watcher_delete', { id: 'a-log' }],
    ] as const) {
      const r = await run(name, args, undefined);
      expect(errorOf(r)).toBe('watchers require a personality context');
    }
    expect(await manager.getWatcher('a-log')).not.toBeNull();
    expect(await manager.getWatcher('x')).toBeNull();
  });
});

describe('an ungated owner’s deliver meets the send_message allowlist', () => {
  const allowlist = (personalityId?: string): string[] | null =>
    personalityId === 'A' ? ['telegram:allowed'] : [];
  const gatesNobody: WatcherOutboxGate = { gates: () => false, ownerTarget: () => undefined };

  it('refuses a deliver target outside the allowlist with send_message’s text', async () => {
    const r = await run(
      'watcher_create',
      { id: 'leak', ...base, deliver: { platform: 'telegram', chat_id: 'stranger' } },
      'A',
      { getAllowedTargets: allowlist, outbox: gatesNobody },
    );
    expect(errorOf(r)).toBe(
      `Target "telegram:stranger" is not in the personality's allowed messaging targets. Allowed: telegram:allowed`,
    );
    expect(await manager.getWatcher('leak')).toBeNull();
  });

  it('accepts an allowlisted target', async () => {
    const r = await run(
      'watcher_create',
      { id: 'ok', ...base, deliver: { platform: 'telegram', chat_id: 'allowed' } },
      'A',
      { getAllowedTargets: allowlist },
    );
    expect(r.ok).toBe(true);
  });

  it('a personality with no allowlist entry can deliver nowhere', async () => {
    const r = await run(
      'watcher_create',
      { id: 'nope', ...base, deliver: { platform: 'telegram', chat_id: 'allowed' } },
      'B',
      { getAllowedTargets: allowlist },
    );
    expect(errorOf(r)).toContain('is not in the personality');
  });

  it('no allowlist wired leaves deliver unchanged', async () => {
    const r = await run(
      'watcher_create',
      { id: 'free', ...base, deliver: { platform: 'telegram', chat_id: 'anyone' } },
      'A',
    );
    expect(r.ok).toBe(true);
  });
});

describe('a stored foreign wake does not fire', () => {
  it('skips the wake and logs a named reason', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/watched');
    await storage.write('/watched/app.log', 'v0');
    const woken: WatcherWakeEvent[] = [];
    const warn = vi.fn();
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
      child: () => logger,
    };
    const m = new WatcherManager({
      storage,
      watchersDir: '/ethos/watchers',
      logger,
      wake: async (e) => {
        woken.push(e);
      },
    });
    // Written before S5: A's record waking B.
    await m.createWatcher({
      id: 'old',
      kind: 'file',
      target: '/watched/app.log',
      intervalSeconds: 60,
      onChange: { wake: { personalityId: 'B', promptPrefix: 'act as A' } },
      owner: { personalityId: 'A' },
    });
    await m.tick('old');
    await storage.write('/watched/app.log', 'v1');
    const result = await m.tick('old');

    expect(result.changed).toBe(true);
    expect(woken).toEqual([]);
    const reasons = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(reasons.join('\n')).toContain(
      'wake of \\"B\\" refused: this watcher belongs to personality \\"A\\"',
    );
  });
});
