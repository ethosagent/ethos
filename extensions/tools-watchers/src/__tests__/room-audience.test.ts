// plan personality-memory-boundary G1, verification round E6 — a shared turn
// sees and acts on only the watchers a shared turn created (`visibleTo`). A
// private or unstamped watcher answers exactly as a missing one, like the
// cross-personality ownership gate in ./ownership.test.ts.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Tool, ToolContext, ToolResult, TurnAudience } from '@ethosagent/types';
import { WatcherManager } from '@ethosagent/watchers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWatcherTools } from '../index';

function ctx(roomAudience?: TurnAudience): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    personalityId: 'A',
    ...(roomAudience ? { roomAudience } : {}),
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

let manager: WatcherManager;
let tools: Map<string, Tool>;

async function run(
  name: string,
  args: Record<string, unknown>,
  audience?: TurnAudience,
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args, ctx(audience));
}

async function seed(id: string, audience?: TurnAudience): Promise<void> {
  const r = await run(
    'watcher_create',
    {
      id,
      kind: 'file',
      target: `/logs/${id}.log`,
      interval_seconds: 60,
      wake: { personality_id: 'A', prompt_prefix: `secret prefix of ${id}` },
    },
    audience,
  );
  if (!r.ok) throw new Error(r.error);
}

beforeEach(() => {
  manager = new WatcherManager({ storage: new InMemoryStorage(), watchersDir: '/ethos/watchers' });
  tools = new Map(createWatcherTools(manager).map((t) => [t.name, t]));
});

describe('watcher tools — room audience', () => {
  it('watcher_list on a shared turn shows only watchers a shared turn created', async () => {
    await seed('priv', 'private');
    await seed('legacy');
    await seed('room', 'shared');
    const listed = await run('watcher_list', {}, 'shared');
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value).toContain('room');
    expect(listed.value).not.toContain('priv');
    expect(listed.value).not.toContain('legacy');
    const all = await run('watcher_list', {}, 'private');
    if (!all.ok) throw new Error(all.error);
    expect(all.value).toContain('priv');
    expect(all.value).toContain('legacy');
  });

  for (const name of ['watcher_pause', 'watcher_resume', 'watcher_delete']) {
    it(`${name} answers a private watcher as missing on a shared turn, and leaves it`, async () => {
      await seed('priv', 'private');
      await seed('legacy');
      const missing = await run(name, { id: 'nope' }, 'shared');
      for (const id of ['priv', 'legacy']) {
        const hidden = await run(name, { id }, 'shared');
        expect(hidden).toEqual({
          ...missing,
          ...(missing.ok ? {} : { error: missing.error.replace('nope', id) }),
        });
        expect(hidden.ok).toBe(false);
        const after = await manager.getWatcher(id);
        expect(after).not.toBeNull();
        if (name === 'watcher_pause') expect(after?.enabled).toBe(true);
      }
    });
  }

  it('a shared turn still manages a shared watcher; a private turn manages every one', async () => {
    await seed('room', 'shared');
    await seed('priv', 'private');
    expect((await run('watcher_pause', { id: 'room' }, 'shared')).ok).toBe(true);
    expect((await run('watcher_delete', { id: 'priv' }, 'private')).ok).toBe(true);
    expect(await manager.getWatcher('priv')).toBeNull();
  });
});
