import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultWorldGraphProviderRegistry } from '@ethosagent/core';
import { SQLiteWorldGraphProvider } from '@ethosagent/world-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWiringContext } from '../build-context';
import { buildInfrastructure } from '../build-infrastructure';
import { DisposerStack } from '../disposer-stack';
import { resolveWorldProvider } from '../world-providers';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-world-providers-'));
  dataDir = join(home, '.ethos');
  mkdirSync(dataDir, { recursive: true });
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('world graph provider registry in wiring', () => {
  it('infrastructure registers sqlite', async () => {
    const opts = { dataDir, workingDir: home, profile: 'web', disableDocker: true } as const;
    const { wiringCtx } = buildWiringContext(opts);
    const disposers = new DisposerStack();
    try {
      const infra = await buildInfrastructure(
        wiringCtx,
        { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' },
        opts,
        disposers,
      );
      expect(infra.worldProviders.list()).toContain('sqlite');
      const factory = resolveWorldProvider(infra.worldProviders, 'sqlite');
      const provider = await factory({
        config: {},
        dataDir,
        secrets: {
          get: async () => null,
          set: async () => {},
          delete: async () => {},
          list: async () => [],
        },
        logger: wiringCtx.log,
      });
      expect(provider).toBeInstanceOf(SQLiteWorldGraphProvider);
      if (provider instanceof SQLiteWorldGraphProvider) provider.dispose();
    } finally {
      await disposers.dispose();
    }
  });

  it('unknown backend name in world.yaml fails with the list of registered names', () => {
    const reg = new DefaultWorldGraphProviderRegistry();
    reg.register('sqlite', () => {
      throw new Error('unused');
    });
    reg.register('neo4j', () => {
      throw new Error('unused');
    });
    expect(() => resolveWorldProvider(reg, 'nope')).toThrow(
      'World graph provider "nope" is not registered. Available: sqlite, neo4j',
    );
  });
});
