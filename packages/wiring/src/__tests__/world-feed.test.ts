// plan world-model 8.2: an rss watcher wakes a turn whose prompt names the target world and loads
// the world-graph skill (`worldFeedWakePrompt`, packages/wiring/src/worlds.ts); the turn proposes
// facts with `world_propose`. No new feed engine and no new AgentLoop.run: the wake is the existing
// `WatcherManagerConfig.wake` path, run here the way `ethos serve` runs it (apps/ethos
// lib/watcher-wake.ts `runWatcherWakeTurn`). Through the real composition root and real access path.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import Database from '@ethosagent/sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, CompletionChunk, CompletionOptions, Message } from '@ethosagent/types';
import { WatcherManager, type WatcherWakeEvent } from '@ethosagent/watchers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../index';
import { expandWorldFeedPrefix, worldFeedPrefix, worldFeedWakePrompt } from '../worlds';
import { usageChunk } from './helpers/usage-test-kit';

const ITEM_URL = 'https://news.example/fab-outage';
const SCHEMA = `version: 1
entities:
  Stock: { attrs: {} }
  Event: { attrs: {} }
edges:
  affected_by: "Stock -> Event"
`;

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-world-feed-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/** A scripted LLM: each model call answers with the next entry; it records what it was shown. */
function scripted(steps: Array<{ tool: string; input: Record<string, unknown> } | string>) {
  const seen: Message[][] = [];
  let call = 0;
  vi.spyOn(AnthropicProvider.prototype, 'complete').mockImplementation(async function* (
    messages: Message[],
    _tools,
    _options: CompletionOptions,
  ): AsyncGenerator<CompletionChunk> {
    seen.push(messages);
    const step = steps[call++] ?? 'done';
    if (typeof step === 'string') {
      yield { type: 'text_delta', text: step };
      yield usageChunk(10, 5, 0.01);
      yield { type: 'done', finishReason: 'end_turn' };
      return;
    }
    yield { type: 'tool_use_start', toolCallId: `c${call}`, toolName: step.tool };
    yield { type: 'tool_use_end', toolCallId: `c${call}`, inputJson: JSON.stringify(step.input) };
    yield usageChunk(10, 5, 0.01);
    yield { type: 'done', finishReason: 'tool_use' };
  });
  return seen;
}

async function assemble() {
  const dataDir = mkdtempSync(join(home, 'data-'));
  process.env.ETHOS_STATE_DIR = dataDir;
  const p = join(dataDir, 'personalities', 'analyst');
  put(join(p, 'config.yaml'), 'name: analyst\n');
  put(join(p, 'SOUL.md'), '# Core\nI am analyst.\n');
  put(
    join(p, 'toolset.yaml'),
    ['world_query', 'world_propose', 'world_assert'].map((t) => `- ${t}\n`).join(''),
  );
  // A shareable world the analyst may propose to, an owner_only one it may read, and its own
  // private world (owner_only by construction): the real mounts ∩ grants ∩ audience path.
  put(
    join(dataDir, 'worlds', 'watch', 'world.yaml'),
    'id: watch\ntitle: Watch\naudience: shareable\nproposers: [analyst]\n',
  );
  put(join(dataDir, 'worlds', 'watch', 'schema.yaml'), SCHEMA);
  put(
    join(dataDir, 'worlds', 'vault', 'world.yaml'),
    'id: vault\ntitle: Vault\naudience: owner_only\nreaders: [analyst]\n',
  );
  put(join(dataDir, 'worlds', 'vault', 'schema.yaml'), SCHEMA);
  put(join(dataDir, 'worlds', '.private', 'analyst', 'schema.yaml'), SCHEMA);
  put(
    join(p, 'worlds.yaml'),
    'mounts:\n  - { world: watch, mode: propose }\n  - { world: vault, mode: read }\n',
  );
  const runtime = await createAgentLoop(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-test',
      compaction: { autoCompact: false },
      memory: 'markdown',
      personality: 'analyst',
      world: { enabled: true },
    },
    { dataDir, workingDir: home, disableDocker: true, profile: 'cli' },
  );
  return { runtime, dataDir };
}

type Runtime = Awaited<ReturnType<typeof assemble>>['runtime'];

const feed = (guids: string[]) =>
  `<rss><channel>${guids
    .map(
      (g) => `<item><title>Title ${g}</title><link>${ITEM_URL}/${g}</link><guid>${g}</guid></item>`,
    )
    .join('')}</channel></rss>`;

/** One rss tick that finds a new item and wakes the loop the way `ethos serve` does. */
async function wakeOnce(
  runtime: Runtime,
  roomAudience: 'private' | 'shared',
): Promise<{ events: AgentEvent[]; event: WatcherWakeEvent }> {
  const events: AgentEvent[] = [];
  let woken: WatcherWakeEvent | undefined;
  let body = feed(['g1']);
  const storage = new InMemoryStorage();
  const manager = new WatcherManager({
    storage,
    watchersDir: '/ethos/watchers',
    fetchFn: async () => new Response(body),
    wake: async (event) => {
      woken = event;
      const prefix = expandWorldFeedPrefix(event.promptPrefix, true);
      for await (const e of runtime.loop.run(`${prefix}\n\n${event.summary}`, {
        sessionKey: `watcher:${event.watcherId}:${roomAudience}`,
        personalityId: event.personalityId,
        roomAudience: event.roomAudience,
        initiator: 'system',
      })) {
        events.push(e);
      }
      return true;
    },
  });
  await manager.createWatcher({
    id: 'feed',
    kind: 'rss',
    target: 'https://news.example/feed.xml',
    intervalSeconds: 60,
    owner: { personalityId: 'analyst', roomAudience },
    onChange: { wake: { personalityId: 'analyst', promptPrefix: worldFeedPrefix('watch') } },
  });
  await manager.tick('feed'); // seed
  body = feed(['g2', 'g1']);
  await manager.tick('feed');
  if (!woken) throw new Error('the watcher did not wake');
  return { events, event: woken };
}

function rows(dataDir: string, sql: string): Array<Record<string, unknown>> {
  const db = new Database(join(dataDir, 'worlds', 'service.db'));
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe('world feeds (8.2)', () => {
  it('a world-feed prefix expands only when world.enabled', () => {
    const prefix = worldFeedPrefix('watch');
    expect(expandWorldFeedPrefix(prefix, true)).toBe(worldFeedWakePrompt('watch'));
    expect(expandWorldFeedPrefix(prefix, false)).toBe(prefix);
    expect(expandWorldFeedPrefix('watch the logs', true)).toBe('watch the logs');
    expect(expandWorldFeedPrefix('world-feed:../etc', true)).toBe('world-feed:../etc');
    expect(expandWorldFeedPrefix(undefined, true)).toBeUndefined();
    expect(worldFeedWakePrompt('watch')).toContain('A graph path is a reason to look, not advice.');
  });

  it('an rss item wakes a turn whose tool calls are world_propose with the item URL as source', async () => {
    const seen = scripted([
      {
        tool: 'world_propose',
        input: {
          world: 'watch',
          why: 'rss item',
          facts: [
            { kind: 'entity', type: 'Event', name: 'fab outage', source_ref: `${ITEM_URL}/g2` },
          ],
        },
      },
      'Proposed one event.',
    ]);
    const { runtime, dataDir } = await assemble();
    try {
      const { events, event } = await wakeOnce(runtime, 'private');
      expect(event.promptPrefix).toBe(worldFeedPrefix('watch'));

      // The turn was told which world and which skill; the item URL reached it.
      const prompt = JSON.stringify(seen[0]);
      expect(prompt).toContain('world-graph');
      expect(prompt).toContain('"watch"');
      expect(prompt).toContain(`${ITEM_URL}/g2`);

      const calls = events.filter((e) => e.type === 'tool_start');
      expect(calls.map((c) => c.type === 'tool_start' && c.toolName)).toEqual(['world_propose']);
      const ends = events.filter((e) => e.type === 'tool_end');
      expect(ends.every((e) => e.type === 'tool_end' && e.ok)).toBe(true);

      // A shared world: the facts are proposals (R1), carrying the item URL as their source.
      const pending = rows(
        dataDir,
        "SELECT world, source_ref FROM proposals WHERE status = 'pending'",
      );
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((r) => r.world === 'world:watch')).toBe(true);
      expect(pending.every((r) => r.source_ref === `${ITEM_URL}/g2`)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 180_000);

  it('a shared-audience wake cannot read an owner_only world', async () => {
    const { runtime } = await assemble();
    try {
      const service = runtime.worlds?.service;
      if (!service) throw new Error('world runtime missing');
      const owner = { personalityId: 'analyst', sessionId: null, surface: 'owner' as const };
      await service.writeFacts(
        { ...owner, audience: 'private' },
        'private',
        [{ kind: 'entity', type: 'Stock', name: 'SECRETCO', sourceRef: 'user', author: 'agent' }],
        '',
      );
      const sharedIds = (await service.visible({ ...owner, audience: 'shared' })).map((w) => w.id);
      const privateIds = (await service.visible({ ...owner, audience: 'private' })).map(
        (w) => w.id,
      );
      expect(sharedIds).toEqual(['world:watch']);
      expect(privateIds).toEqual(
        expect.arrayContaining(['personality:analyst', 'world:vault', 'world:watch']),
      );

      // The woken turn (a watcher with a shared owner) queries every visible world and the vault.
      scripted([
        { tool: 'world_query', input: { text: 'SECRETCO' } },
        { tool: 'world_query', input: { world: 'vault', text: 'SECRETCO' } },
        'nothing found',
      ]);
      const { events, event } = await wakeOnce(runtime, 'shared');
      expect(event.roomAudience).toBe('shared');
      const ends = events.filter((e) => e.type === 'tool_end');
      expect(ends).toHaveLength(2);
      for (const e of ends) {
        expect(JSON.stringify(e)).not.toContain('SECRETCO');
      }
      // The explicit vault read is refused, not empty-handed success.
      expect(ends[1]?.type === 'tool_end' && ends[1].ok).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
});
