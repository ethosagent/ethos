import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFeedItems } from '../differs';
import {
  MIN_INTERVAL_SECONDS,
  WATCHER_SYSTEM_TASK,
  type WatcherCreateInput,
  type WatcherDeliverTarget,
  WatcherManager,
  type WatcherSchedulerPort,
  type WatcherWakeEvent,
} from '../index';

const DIR = '/ethos/watchers';

interface Harness {
  storage: InMemoryStorage;
  manager: WatcherManager;
  delivered: Array<{ target: WatcherDeliverTarget; text: string }>;
  woken: WatcherWakeEvent[];
  fetchImpl: { fn: typeof fetch };
  probeAlive: { value: boolean; error?: Error };
}

function makeHarness(): Harness {
  const storage = new InMemoryStorage();
  const delivered: Array<{ target: WatcherDeliverTarget; text: string }> = [];
  const woken: WatcherWakeEvent[] = [];
  const fetchImpl: { fn: typeof fetch } = {
    fn: () => Promise.reject(new Error('fetch not stubbed')),
  };
  const probeAlive: { value: boolean; error?: Error } = { value: true };
  const manager = new WatcherManager({
    storage,
    watchersDir: DIR,
    deliver: async (target, text) => {
      delivered.push({ target, text });
    },
    wake: async (event) => {
      woken.push(event);
    },
    fetchFn: ((...args: Parameters<typeof fetch>) => fetchImpl.fn(...args)) as typeof fetch,
    processProbe: async () => {
      if (probeAlive.error) throw probeAlive.error;
      return probeAlive.value;
    },
  });
  return { storage, manager, delivered, woken, fetchImpl, probeAlive };
}

function fileWatcher(overrides: Partial<WatcherCreateInput> = {}): WatcherCreateInput {
  return {
    id: 'my-file',
    kind: 'file',
    target: '/watched/app.log',
    intervalSeconds: 60,
    onChange: { deliver: { platform: 'telegram', chatId: '123' } },
    ...overrides,
  };
}

function httpResponse(body: string, opts: { status?: number; etag?: string } = {}): Response {
  return new Response(opts.status === 304 ? null : body, {
    status: opts.status ?? 200,
    headers: opts.etag ? { etag: opts.etag } : {},
  });
}

let h: Harness;

beforeEach(async () => {
  h = makeHarness();
  await h.storage.mkdir('/watched');
});

describe('validation', () => {
  it('rejects intervalSeconds < 60', async () => {
    await expect(h.manager.createWatcher(fileWatcher({ intervalSeconds: 30 }))).rejects.toThrow(
      `intervalSeconds must be an integer >= ${MIN_INTERVAL_SECONDS}`,
    );
  });

  it('rejects a watcher with neither deliver nor wake', async () => {
    await expect(h.manager.createWatcher(fileWatcher({ onChange: {} }))).rejects.toThrow(
      'at least one of deliver or wake',
    );
  });

  it('rejects invalid ids, unknown kinds, empty targets, and duplicates', async () => {
    await expect(h.manager.createWatcher(fileWatcher({ id: 'Has_Upper' }))).rejects.toThrow(
      'Invalid watcher id',
    );
    await expect(
      h.manager.createWatcher({ ...fileWatcher(), kind: 'webhook' as never }),
    ).rejects.toThrow('Invalid watcher kind');
    await expect(h.manager.createWatcher(fileWatcher({ target: '  ' }))).rejects.toThrow(
      'target is required',
    );
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher());
    await expect(h.manager.createWatcher(fileWatcher())).rejects.toThrow('already exists');
  });

  it('rejects deliver without explicit platform/chatId and wake without personalityId', async () => {
    await expect(
      h.manager.createWatcher(
        fileWatcher({ onChange: { deliver: { platform: 'telegram', chatId: '' } } }),
      ),
    ).rejects.toThrow('explicit platform and chatId');
    await expect(
      h.manager.createWatcher(fileWatcher({ onChange: { wake: { personalityId: ' ' } } })),
    ).rejects.toThrow('wake requires personalityId');
  });
});

describe('tick — unchanged content', () => {
  it('two ticks over unchanged content → one state write total, zero deliver/wake', async () => {
    await h.storage.write('/watched/app.log', 'stable content');
    await h.manager.createWatcher(fileWatcher());
    const writeSpy = vi.spyOn(h.storage, 'writeAtomic');

    const first = await h.manager.tick('my-file');
    const second = await h.manager.tick('my-file');

    expect(first).toEqual({ changed: false });
    expect(second).toEqual({ changed: false });
    const stateWrites = writeSpy.mock.calls.filter(([path]) =>
      String(path).includes('/state/my-file.json'),
    );
    expect(stateWrites).toHaveLength(1); // initial seed only
    expect(h.delivered).toHaveLength(0);
    expect(h.woken).toHaveLength(0);
  });
});

describe('file watcher', () => {
  it('detects a content-hash change and delivers a summary', async () => {
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher());
    await h.manager.tick('my-file'); // seed

    await h.storage.write('/watched/app.log', 'v2');
    const result = await h.manager.tick('my-file');

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('file changed: /watched/app.log');
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.target).toEqual({ platform: 'telegram', chatId: '123' });
    expect(h.delivered[0]?.text).toContain('file changed: /watched/app.log');
  });

  it('treats disappearing and appearing as changes', async () => {
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher());
    await h.manager.tick('my-file'); // seed

    await h.storage.remove('/watched/app.log');
    const removed = await h.manager.tick('my-file');
    expect(removed.changed).toBe(true);
    expect(removed.summary).toBe('file removed: /watched/app.log');

    await h.storage.write('/watched/app.log', 'v1');
    const appeared = await h.manager.tick('my-file');
    expect(appeared.changed).toBe(true);
    expect(appeared.summary).toBe('file appeared: /watched/app.log');
  });
});

describe('http watcher', () => {
  const input = (): WatcherCreateInput =>
    fileWatcher({ id: 'my-http', kind: 'http', target: 'https://example.com/status' });

  it('detects ETag/content change; 304 and network errors are not changes', async () => {
    h.fetchImpl.fn = async () => httpResponse('body-1', { etag: '"a"' });
    await h.manager.createWatcher(input());
    await h.manager.tick('my-http'); // seed

    // 304 → no change, no state write; the stored ETag rides If-None-Match
    const writeSpy = vi.spyOn(h.storage, 'writeAtomic');
    let sentEtag: string | null = null;
    h.fetchImpl.fn = async (_url, init) => {
      sentEtag = new Headers(init?.headers).get('If-None-Match');
      return httpResponse('', { status: 304 });
    };
    expect(await h.manager.tick('my-http')).toEqual({ changed: false });
    expect(sentEtag).toBe('"a"');

    // network error → no change, prior state kept
    h.fetchImpl.fn = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await h.manager.tick('my-http')).toEqual({ changed: false });
    const stateWrites = () =>
      writeSpy.mock.calls.filter(([path]) => String(path).includes('/state/my-http.json'));
    expect(stateWrites()).toHaveLength(0);

    // content change → change (detected against the state from before the error)
    h.fetchImpl.fn = async () => httpResponse('body-2', { etag: '"b"' });
    const result = await h.manager.tick('my-http');
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('HTTP target changed: https://example.com/status');
    expect(stateWrites()).toHaveLength(1);
  });

  it('non-2xx responses are errors, not changes', async () => {
    h.fetchImpl.fn = async () => httpResponse('ok', { etag: '"a"' });
    await h.manager.createWatcher(input());
    await h.manager.tick('my-http'); // seed

    h.fetchImpl.fn = async () => httpResponse('oops', { status: 500 });
    expect(await h.manager.tick('my-http')).toEqual({ changed: false });
    expect(h.delivered).toHaveLength(0);
  });
});

describe('rss watcher', () => {
  const feed = (items: string[]): string =>
    `<rss><channel>${items
      .map((i) => `<item><guid>${i}</guid><title>Title ${i}</title></item>`)
      .join('')}</channel></rss>`;

  it('alerts only on new GUIDs', async () => {
    h.fetchImpl.fn = async () => new Response(feed(['g1', 'g2']));
    await h.manager.createWatcher(
      fileWatcher({ id: 'my-rss', kind: 'rss', target: 'https://example.com/feed.xml' }),
    );
    await h.manager.tick('my-rss'); // seed — no alert for existing items
    expect(h.delivered).toHaveLength(0);

    // Same feed → nothing
    expect(await h.manager.tick('my-rss')).toEqual({ changed: false });

    // One new item → change with title in the summary
    h.fetchImpl.fn = async () => new Response(feed(['g3', 'g1', 'g2']));
    const result = await h.manager.tick('my-rss');
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('1 new RSS item: Title g3');
    expect(h.delivered).toHaveLength(1);
  });

  it('parses guid, falls back to link, then title hash', () => {
    const xml = `
      <rss><channel>
        <item><guid>abc</guid><title>A</title></item>
        <item><link>https://x/1</link><title>B</title></item>
        <item><title>C</title></item>
      </channel></rss>`;
    const items = parseFeedItems(xml);
    expect(items.map((i) => i.title)).toEqual(['A', 'B', 'C']);
    expect(items[0]?.guid).toBe('abc');
    expect(items[1]?.guid).toBe('https://x/1');
    expect(items[2]?.guid).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('process watcher', () => {
  it('alerts on alive→dead and dead→alive transitions', async () => {
    await h.manager.createWatcher(
      fileWatcher({
        id: 'my-proc',
        kind: 'process',
        target: 'nginx',
        onChange: { wake: { personalityId: 'ops', promptPrefix: 'Investigate:' } },
      }),
    );
    h.probeAlive.value = true;
    await h.manager.tick('my-proc'); // seed
    expect(h.woken).toHaveLength(0);

    h.probeAlive.value = false;
    const dead = await h.manager.tick('my-proc');
    expect(dead.changed).toBe(true);
    expect(dead.summary).toBe('process nginx is now dead');

    h.probeAlive.value = true;
    const alive = await h.manager.tick('my-proc');
    expect(alive.changed).toBe(true);
    expect(alive.summary).toBe('process nginx is now alive');
    expect(h.woken).toHaveLength(2);
  });

  it('probe errors are not changes', async () => {
    await h.manager.createWatcher(fileWatcher({ id: 'my-proc', kind: 'process', target: 'x' }));
    h.probeAlive.value = true;
    await h.manager.tick('my-proc');
    h.probeAlive.error = new Error('ps unavailable');
    expect(await h.manager.tick('my-proc')).toEqual({ changed: false });
    expect(h.delivered).toHaveLength(0);
  });
});

describe('callbacks', () => {
  it('wake receives watcherId, target, personalityId, promptPrefix, and summary', async () => {
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(
      fileWatcher({
        onChange: {
          deliver: { platform: 'slack', chatId: 'C42' },
          wake: { personalityId: 'ops', promptPrefix: 'Check this.' },
        },
      }),
    );
    await h.manager.tick('my-file');
    await h.storage.write('/watched/app.log', 'v2');
    await h.manager.tick('my-file');

    // Both callbacks fire when both are configured
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.target).toEqual({ platform: 'slack', chatId: 'C42' });
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]).toEqual({
      watcherId: 'my-file',
      target: '/watched/app.log',
      personalityId: 'ops',
      promptPrefix: 'Check this.',
      summary: expect.stringContaining('file changed'),
    });
  });
});

describe('pause / resume', () => {
  it('paused watcher ticks produce nothing; resume continues from prior state', async () => {
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher());
    await h.manager.tick('my-file'); // seed

    await h.manager.pauseWatcher('my-file');
    await h.storage.write('/watched/app.log', 'v2');
    expect(await h.manager.tick('my-file')).toEqual({ changed: false });
    expect(h.delivered).toHaveLength(0);

    await h.manager.resumeWatcher('my-file');
    const result = await h.manager.tick('my-file');
    expect(result.changed).toBe(true); // v1→v2 detected against pre-pause state
    expect(h.delivered).toHaveLength(1);
  });
});

describe('scheduler integration', () => {
  function makePort(): WatcherSchedulerPort & {
    seeded: Array<{ name: string; schedule: string; systemTask: string }>;
    removed: string[];
  } {
    const seeded: Array<{ name: string; schedule: string; systemTask: string }> = [];
    const removed: string[] = [];
    return {
      seeded,
      removed,
      seedSystemJob: async (params) => {
        seeded.push({
          name: params.name,
          schedule: params.schedule,
          systemTask: params.systemTask,
        });
        return {};
      },
      removeSystemJob: async (id) => {
        removed.push(id);
      },
    };
  }

  it('create/pause/resume/remove register and deregister the backing system job', async () => {
    const port = makePort();
    h.manager.attachScheduler(port);
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher({ intervalSeconds: 120 }));
    expect(port.seeded).toEqual([
      { name: 'watcher-my-file', schedule: 'every 120s', systemTask: WATCHER_SYSTEM_TASK },
    ]);

    await h.manager.pauseWatcher('my-file');
    expect(port.removed).toContain('watcher-my-file');

    await h.manager.resumeWatcher('my-file');
    expect(port.seeded).toHaveLength(2);

    await h.manager.removeWatcher('my-file');
    expect(port.removed.filter((id) => id === 'watcher-my-file').length).toBeGreaterThanOrEqual(2);
  });

  it('start() re-registers enabled watchers only', async () => {
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher());
    await h.manager.createWatcher(fileWatcher({ id: 'paused-one' }));
    await h.manager.pauseWatcher('paused-one');

    const port = makePort();
    h.manager.attachScheduler(port);
    await h.manager.start();
    expect(port.seeded.map((s) => s.name)).toEqual(['watcher-my-file']);
  });

  it('the systemTask handler maps job id → watcher tick and returns summary as output', async () => {
    await h.storage.write('/watched/app.log', 'v1');
    await h.manager.createWatcher(fileWatcher());
    const handler = h.manager.systemTasks()[WATCHER_SYSTEM_TASK];
    if (!handler) throw new Error('handler missing');

    expect(await handler({ id: 'watcher-my-file' })).toEqual({ output: '' }); // seed
    await h.storage.write('/watched/app.log', 'v2');
    const changed = await handler({ id: 'watcher-my-file' });
    expect(changed.output).toContain('file changed');
    expect(await handler({ id: 'not-a-watcher-job' })).toEqual({ output: '' });
  });
});
