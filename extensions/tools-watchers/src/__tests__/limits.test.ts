// Standing intents with limits (plan personality-presence-and-initiative §5):
// the agent-facing half — a tool-created watcher always has a budget.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import {
  DEFAULT_WATCHER_MAX_FIRES,
  MAX_AGENT_WATCHER_FIRES,
  MAX_WATCHERS_PER_OWNER,
  WatcherManager,
} from '@ethosagent/watchers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWatcherTools } from '../index';

const ctx: ToolContext = {
  sessionId: 's',
  sessionKey: 'cli:test',
  platform: 'cli',
  personalityId: 'ops',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
  initiator: 'user',
};

const createArgs = {
  id: 'ops-log',
  kind: 'file',
  target: '/logs/app.log',
  interval_seconds: 60,
  wake: { personality_id: 'ops' },
};

let manager: WatcherManager;
let tools: Map<string, ReturnType<typeof createWatcherTools>[number]>;

async function run(name: string, args: unknown, turn: ToolContext = ctx) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args, turn);
}

beforeEach(() => {
  manager = new WatcherManager({ storage: new InMemoryStorage(), watchersDir: '/ethos/watchers' });
  tools = new Map(createWatcherTools(manager).map((t) => [t.name, t]));
});

describe('watcher_create limits', () => {
  it('a tool-created watcher with no limits has the default budget', async () => {
    expect((await run('watcher_create', createArgs)).ok).toBe(true);
    expect((await manager.getWatcher('ops-log'))?.limits?.maxFires).toBe(DEFAULT_WATCHER_MAX_FIRES);
    const listed = await run('watcher_list', {});
    expect(listed.ok && listed.value).toContain(
      `${DEFAULT_WATCHER_MAX_FIRES} of ${DEFAULT_WATCHER_MAX_FIRES} fires left`,
    );
  });

  it('refuses max_fires: 0 — unlimited is operator-only', async () => {
    const result = await run('watcher_create', { ...createArgs, limits: { max_fires: 0 } });
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    if (!result.ok) expect(result.error).toContain('max_fires');
    expect(await manager.getWatcher('ops-log')).toBeNull();
  });

  it('passes expiry, cooldown and budget through to the record', async () => {
    const expiresAt = '2099-01-01T00:00:00.000Z';
    const result = await run('watcher_create', {
      ...createArgs,
      limits: { expires_at: expiresAt, cooldown_seconds: 600, max_fires: 3 },
    });
    expect(result.ok).toBe(true);
    expect((await manager.getWatcher('ops-log'))?.limits).toEqual({
      expiresAt,
      cooldownSeconds: 600,
      maxFires: 3,
    });
  });

  it('watcher_list shows why a watcher stopped', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/logs');
    await storage.write('/logs/app.log', 'v0');
    manager = new WatcherManager({
      storage,
      watchersDir: '/ethos/watchers',
      wake: async () => {},
    });
    tools = new Map(createWatcherTools(manager).map((t) => [t.name, t]));
    await run('watcher_create', { ...createArgs, limits: { max_fires: 1 } });
    await manager.tick('ops-log');
    await storage.write('/logs/app.log', 'v1');
    await manager.tick('ops-log');
    await storage.write('/logs/app.log', 'v2');
    await manager.tick('ops-log');

    const listed = await run('watcher_list', {});
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toContain('(paused)');
      expect(listed.value).toContain('0 of 1 fires left');
      expect(listed.value).toContain('fire budget');
    }
  });
});

describe('only a person-started turn grows or refills watchers (C1a)', () => {
  const wakeTurn: ToolContext = { ...ctx, initiator: 'system' };
  const unsaidTurn: ToolContext = { ...ctx, initiator: undefined };

  it('a wake/cron (system) turn cannot create, delete or resume; it can still pause', async () => {
    for (const turn of [wakeTurn, unsaidTurn]) {
      const created = await run('watcher_create', createArgs, turn);
      expect(created).toMatchObject({ ok: false, code: 'input_invalid' });
      if (!created.ok) expect(created.error).toContain('person');
    }
    expect(await manager.getWatcher('ops-log')).toBeNull();

    expect((await run('watcher_create', createArgs)).ok).toBe(true);
    expect((await run('watcher_pause', { id: 'ops-log' }, wakeTurn)).ok).toBe(true);
    expect((await run('watcher_resume', { id: 'ops-log' }, wakeTurn)).ok).toBe(false);
    expect((await manager.getWatcher('ops-log'))?.enabled).toBe(false);
    expect((await run('watcher_delete', { id: 'ops-log' }, wakeTurn)).ok).toBe(false);
    expect(await manager.getWatcher('ops-log')).not.toBeNull();

    // A person-started turn still can.
    expect((await run('watcher_resume', { id: 'ops-log' })).ok).toBe(true);
    expect((await run('watcher_delete', { id: 'ops-log' })).ok).toBe(true);
  });
});

describe('max_fires ceiling (C2)', () => {
  it('refuses max_fires above MAX_AGENT_WATCHER_FIRES, including 1e308', async () => {
    for (const max_fires of [1e308, MAX_AGENT_WATCHER_FIRES + 1]) {
      const result = await run('watcher_create', { ...createArgs, limits: { max_fires } });
      expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
      if (!result.ok) expect(result.error).toContain(String(MAX_AGENT_WATCHER_FIRES));
    }
    expect(await manager.getWatcher('ops-log')).toBeNull();
    const ok = await run('watcher_create', {
      ...createArgs,
      limits: { max_fires: MAX_AGENT_WATCHER_FIRES },
    });
    expect(ok.ok).toBe(true);
  });
});

describe('per-owner watcher cap (C1b)', () => {
  it('refuses a watcher past MAX_WATCHERS_PER_OWNER active', async () => {
    for (let i = 0; i < MAX_WATCHERS_PER_OWNER; i++) {
      expect((await run('watcher_create', { ...createArgs, id: `w${i}` })).ok).toBe(true);
    }
    const result = await run('watcher_create', { ...createArgs, id: 'one-more' });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(String(MAX_WATCHERS_PER_OWNER));
  });
});

describe('expires_at format (C5)', () => {
  it('refuses a human date and a zone-less time', async () => {
    for (const expires_at of ['October 1', '2099-10-01T09:00:00']) {
      const result = await run('watcher_create', { ...createArgs, limits: { expires_at } });
      expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    }
  });
});
