// plan world-model 8.4: `createWorldChangesSource` (packages/wiring/src/worlds.ts) turns the
// world service's change feed into the digest's "World changes" data, through the real
// composition root: opened/closed links, new Event entities, the pending proposal count and a
// ripple notice per new event.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, createWorldChangesSource } from '../index';

const SCHEMA = readFileSync(
  join(process.cwd(), 'extensions/world-service/templates/watchlist.schema.yaml'),
  'utf8',
);

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-world-changes-'));
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

const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

describe('createWorldChangesSource (8.4)', () => {
  it('reports links, new events, pending proposals and ripple notices per world', async () => {
    const dataDir = mkdtempSync(join(home, 'data-'));
    process.env.ETHOS_STATE_DIR = dataDir;
    const p = join(dataDir, 'personalities', 'analyst');
    put(join(p, 'config.yaml'), 'name: analyst\n');
    put(join(p, 'SOUL.md'), '# Core\nI am analyst.\n');
    put(join(p, 'toolset.yaml'), '- read_file\n');
    for (const [slug, audience] of [
      ['watch', 'shareable'],
      ['vault', 'owner_only'],
    ] as const) {
      put(
        join(dataDir, 'worlds', slug, 'world.yaml'),
        `id: ${slug}\ntitle: ${slug}\naudience: ${audience}\nproposers: [analyst]\n`,
      );
      put(join(dataDir, 'worlds', slug, 'schema.yaml'), SCHEMA);
    }
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
    try {
      const worlds = runtime.worlds;
      if (!worlds) throw new Error('world runtime missing');
      const { service } = worlds;
      const id = 'world:watch' as const;
      const ent = async (type: string, name: string): Promise<string> => {
        const out = await service.ownerWrite(
          id,
          [{ kind: 'entity', type, name, sourceRef: 'test', author: 'user' }],
          'test',
        );
        return out.applied[0] as string;
      };
      const [fabr, nvx, skyc, volt, list] = [
        await ent('Stock', 'FABR'),
        await ent('Stock', 'NVX'),
        await ent('Stock', 'SKYC'),
        await ent('Stock', 'VOLT'),
        await ent('List', 'Core'),
      ];
      const outage = await ent('Event', 'fab outage');
      const edge = async (type: string, fromId: string, toId: string): Promise<string> => {
        const out = await service.ownerWrite(
          id,
          [
            {
              kind: 'edge',
              type,
              fromId,
              toId,
              sourceRef: 'https://news.example/a',
              author: 'user',
              confidence: 0.9,
            },
          ],
          'test',
        );
        return out.applied[0] as string;
      };
      await edge('affected_by', fabr, outage);
      await edge('supplies', fabr, nvx);
      await edge('supplies', nvx, skyc);
      const toClose = await edge('supplies', nvx, volt);
      await edge('watched_in', nvx, list);
      await edge('watched_in', skyc, list);
      await edge('watched_in', volt, list);
      await service.ownerClose(id, toClose, new Date().toISOString().slice(0, 10), 'test');

      const source = createWorldChangesSource({ service, configService: worlds.configService });
      const now = Date.now();
      const report = await source({
        from: new Date(now - 3_600_000),
        to: new Date(now + 3_600_000),
      });
      expect(report.rippleDisclaimer).toBe('A graph path is a reason to look, not advice.');
      const watch = report.worlds.find((w) => w.world === 'watch');
      expect(watch).toMatchObject({
        audience: 'shareable',
        linksOpened: 7,
        linksClosed: 1,
        newEvents: ['fab outage'],
        pendingProposals: 0,
      });
      // The closed NVX -> VOLT link is not walked, so VOLT is not reported.
      expect(watch?.ripples).toEqual([
        'fab outage: FABR → NVX (sources: https://news.example/a)',
        'fab outage: FABR → NVX → SKYC (sources: https://news.example/a)',
      ]);
      expect(report.worlds.find((w) => w.world === 'vault')).toMatchObject({
        audience: 'owner_only',
        linksOpened: 0,
        newEvents: [],
      });

      // Outside the window nothing is counted.
      const later = await source({
        from: new Date(now + 3_600_000),
        to: new Date(now + 7_200_000),
      });
      expect(later.worlds.find((w) => w.world === 'watch')).toMatchObject({
        linksOpened: 0,
        newEvents: [],
      });
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
});
