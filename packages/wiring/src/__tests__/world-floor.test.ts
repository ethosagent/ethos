// plan world-model Task 2.5, R4 (docs/decisions/0012-world-graph-contract.md):
// no turn can write a world's definition or a personality's mounts.
//
// - `worlds/` (world.yaml, schema.yaml, graph.db, service.db) is on the
//   state-dir deny list, read AND write (`STATE_DIR_DENY_ENTRIES`,
//   packages/storage-fs/src/sensitive-paths.ts): a read of schema.yaml or
//   world.yaml would also show the owner-only world's shape to a shared turn.
// - `personalities/<id>/worlds.yaml` is a personality-definition entry
//   (`PERSONALITY_DEFINITION_ENTRIES`, packages/types/src/personality-definition.ts),
//   so WRITE-floored for every personality and still readable (the definition
//   floor is write-only: a turn may read what it cannot change).
// - Both are exercised through the REAL `shippedScopedStorageFactory`
//   (build-agent-loop.ts), then through a real `createAgentLoop` on a custom
//   dataDir (the custom-datadir-floor.test.ts pattern).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storageFs from '@ethosagent/storage-fs';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { BoundaryError, type ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shippedScopedStorageFactory } from '../build-agent-loop';
import { createAgentLoop, type WiringConfig } from '../index';

async function seeded(stateDir: string) {
  const base = new InMemoryStorage();
  await base.mkdir(join(stateDir, 'worlds', 'acme'));
  await base.mkdir(join(stateDir, 'personalities', 'engineer'));
  await base.write(join(stateDir, 'worlds', 'acme', 'schema.yaml'), 'kinds: []\n');
  await base.write(join(stateDir, 'personalities', 'engineer', 'worlds.yaml'), 'mounts: []\n');
  return base;
}

describe('R4 file tools cannot write worlds/ or worlds.yaml', () => {
  for (const [label, stateDir, dataDir] of [
    ['~/.ethos', join(homedir(), '.ethos'), undefined],
    ['a custom dataDir', '/srv/custom-ethos-data', '/srv/custom-ethos-data'],
  ] as const) {
    it(`on ${label}: worlds/ is refused for read and write, worlds.yaml for write only`, async () => {
      const base = await seeded(stateDir);
      const factory = shippedScopedStorageFactory(storageFs, dataDir);
      // A reach that covers the whole state dir: only the floors can refuse.
      const scoped = factory(base, { read: [`${stateDir}/`], write: [`${stateDir}/`] });
      const schema = join(stateDir, 'worlds', 'acme', 'schema.yaml');
      const mounts = join(stateDir, 'personalities', 'engineer', 'worlds.yaml');

      await expect(scoped.write(schema, 'kinds: [x]\n')).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.read(schema)).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.write(mounts, 'mounts: []\n')).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.read(mounts)).resolves.toBe('mounts: []\n');
      // A directory created mid-turn is floored too, not only existing ones.
      await expect(
        scoped.write(join(stateDir, 'personalities', 'brand-new', 'worlds.yaml'), 'x'),
      ).rejects.toBeInstanceOf(BoundaryError);
      expect(await base.read(schema)).toBe('kinds: []\n');
    });
  }
});

describe('R4 through the real wiring on a custom dataDir (custom-datadir-floor.test.ts pattern)', () => {
  let root: string;
  let dataDir: string;
  let runtime: Awaited<ReturnType<typeof createAgentLoop>>;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ethos-world-floor-'));
    dataDir = join(root, 'desktop-data');
    const own = join(dataDir, 'personalities', 'p');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'config.yaml'), 'name: p\n');
    writeFileSync(join(own, 'SOUL.md'), '# p\n');
    writeFileSync(join(own, 'toolset.yaml'), '- read_file\n- write_file\n');
    writeFileSync(join(own, 'worlds.yaml'), 'mounts: []\n');
    writeFileSync(join(dataDir, 'constitution.yaml'), 'tools: {}\n');
    mkdirSync(join(dataDir, 'worlds', 'acme'), { recursive: true });
    writeFileSync(join(dataDir, 'worlds', 'acme', 'schema.yaml'), 'kinds: []\n');
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = join(root, 'home');
    delete process.env.ETHOS_STATE_DIR;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: 'p',
      memory: 'markdown',
    };
    runtime = await createAgentLoop(config, {
      dataDir,
      workingDir: root,
      disableDocker: true,
      profile: 'cli',
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const ctx = (): ToolContext =>
    ({
      sessionId: 's',
      sessionKey: 'cli:world-floor',
      platform: 'cli',
      personalityId: 'p',
      workingDir: root,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    }) as ToolContext;

  async function call(name: string, args: Record<string, unknown>) {
    const [result] = await runtime.toolRegistry.executeParallel(
      [{ toolCallId: 'c1', name, args }],
      ctx(),
    );
    return result?.result;
  }

  it('write_file and read_file on worlds/<slug>/schema.yaml are refused', async () => {
    const path = join(dataDir, 'worlds', 'acme', 'schema.yaml');
    expect((await call('write_file', { path, content: 'kinds: [x]\n' }))?.ok).toBe(false);
    expect((await call('read_file', { path }))?.ok).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('kinds: []\n');
  });

  it('write_file to personalities/<id>/worlds.yaml is refused, even for the personality itself', async () => {
    const path = join(dataDir, 'personalities', 'p', 'worlds.yaml');
    expect(
      (await call('write_file', { path, content: 'mounts: [{world: acme, mode: read}]\n' }))?.ok,
    ).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('mounts: []\n');
  });

  it('read_file of worlds.yaml succeeds (the definition floor is write-only)', async () => {
    const path = join(dataDir, 'personalities', 'p', 'worlds.yaml');
    const result = await call('read_file', { path });
    expect(result?.ok).toBe(true);
  });
});
