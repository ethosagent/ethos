import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { WatcherManager } from '@ethosagent/watchers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWatcherTools } from '../index';

const ctx: ToolContext = {
  sessionId: 's',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

let storage: InMemoryStorage;
let tools: Map<string, ReturnType<typeof createWatcherTools>[number]>;

async function run(name: string, args: unknown) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args, ctx);
}

const createArgs = {
  id: 'ops-log',
  kind: 'file',
  target: '/logs/app.log',
  interval_seconds: 60,
  deliver: { platform: 'telegram', chat_id: '99' },
};

beforeEach(() => {
  storage = new InMemoryStorage();
  const manager = new WatcherManager({ storage, watchersDir: '/ethos/watchers' });
  tools = new Map(createWatcherTools(manager).map((t) => [t.name, t]));
});

describe('watcher tools', () => {
  it('registers the five watcher_* tools under the watchers toolset', () => {
    expect([...tools.keys()].sort()).toEqual([
      'watcher_create',
      'watcher_delete',
      'watcher_list',
      'watcher_pause',
      'watcher_resume',
    ]);
    for (const tool of tools.values()) expect(tool.toolset).toBe('watchers');
  });

  it('create → list → pause → resume → delete round-trip', async () => {
    const created = await run('watcher_create', createArgs);
    expect(created.ok).toBe(true);

    let listed = await run('watcher_list', {});
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toContain('ops-log [file] /logs/app.log');
      expect(listed.value).toContain('deliver → telegram:99');
      expect(listed.value).toContain('(active)');
    }

    expect((await run('watcher_pause', { id: 'ops-log' })).ok).toBe(true);
    listed = await run('watcher_list', {});
    if (listed.ok) expect(listed.value).toContain('(paused)');

    expect((await run('watcher_resume', { id: 'ops-log' })).ok).toBe(true);
    expect((await run('watcher_delete', { id: 'ops-log' })).ok).toBe(true);
    listed = await run('watcher_list', {});
    if (listed.ok) expect(listed.value).toBe('No watchers configured.');
  });

  it('rejects interval_seconds < 60', async () => {
    const result = await run('watcher_create', { ...createArgs, interval_seconds: 30 });
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    if (!result.ok) expect(result.error).toContain('intervalSeconds must be an integer >= 60');
  });

  it('rejects a watcher with neither deliver nor wake', async () => {
    const { deliver: _deliver, ...noAction } = createArgs;
    const result = await run('watcher_create', noAction);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    if (!result.ok) expect(result.error).toContain('at least one of deliver or wake');
  });

  it('rejects incomplete deliver/wake blocks and missing fields', async () => {
    expect(
      await run('watcher_create', { ...createArgs, deliver: { platform: 'telegram' } }),
    ).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(
      await run('watcher_create', { ...createArgs, deliver: undefined, wake: {} }),
    ).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(await run('watcher_create', { ...createArgs, id: undefined })).toMatchObject({
      ok: false,
      code: 'input_invalid',
    });
    expect(await run('watcher_pause', {})).toMatchObject({ ok: false, code: 'input_invalid' });
  });

  it('lifecycle tools surface not-found errors', async () => {
    const result = await run('watcher_pause', { id: 'nope' });
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    if (!result.ok) expect(result.error).toContain('Watcher not found');
  });
});
