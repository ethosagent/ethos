import type { EthosConfig } from '@ethosagent/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MigrateCommandDeps, runMigrate } from '../migrate-models';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos migrate models --json` prints exactly one JSON document.
// It never prompts: without --yes it refuses (refuseJson). Deps are doubles, as in migrate-models.test.ts.

let h: JsonCliHarness;
const saved: EthosConfig[] = [];

beforeEach(async () => {
  h = await setupJsonCli('ethos-migrate-json-');
  saved.length = 0;
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = 0;
  await h.teardown();
});

function userConfig(): EthosConfig {
  return {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    apiKey: '',
    personality: 'researcher',
    providers: [{ provider: 'codex', id: 'codex-gpt-terra', model: 'gpt-5.6-terra', apiKey: '' }],
  } as EthosConfig;
}

function deps(config: EthosConfig | null): MigrateCommandDeps {
  return {
    loadConfig: async () => config,
    saveConfig: async (next) => {
      saved.push(next);
    },
    confirm: async () => {
      throw new Error('--json must never prompt');
    },
    isTTY: true,
    lookupCatalog: () => undefined,
  };
}

describe('migrate models --json', () => {
  it('--json --yes success is one JSON doc', async () => {
    await runMigrate(['models', '--yes', '--json'], deps(userConfig()));
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.changed).toBe(true);
    expect(doc.diff).toEqual(expect.arrayContaining([expect.stringContaining('modelRegistry.')]));
    expect(doc.adopted).toEqual([expect.objectContaining({ modelId: 'gpt-5.6-terra' })]);
    expect(saved).toHaveLength(1);
  });

  it('--json with nothing to import is one JSON doc', async () => {
    await runMigrate(
      ['models', '--json'],
      deps({ ...userConfig(), model: '', providers: undefined }),
    );
    expect(parseOneDoc(h)).toMatchObject({ ok: true, changed: false, diff: [] });
    expect(saved).toHaveLength(0);
  });

  it('--json without --yes is refused as one JSON doc and writes nothing', async () => {
    await expect(runMigrate(['models', '--json'], deps(userConfig()))).rejects.toThrow(
      `${EXIT}(1)`,
    );
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
    expect(saved).toHaveLength(0);
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runMigrate(['bogus', '--json'], deps(null))).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('--json with no config is one JSON doc', async () => {
    await expect(runMigrate(['models', '--yes', '--json'], deps(null))).rejects.toThrow(
      `${EXIT}(1)`,
    );
    expect(parseOneDoc(h).error?.code).toBe('CONFIG_MISSING');
  });
});
