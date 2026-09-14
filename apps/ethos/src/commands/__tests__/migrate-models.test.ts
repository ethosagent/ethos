import type { EthosConfig } from '@ethosagent/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATE_MODELS_YES, type MigrateCommandDeps, runMigrate } from '../migrate-models';

// `ethos migrate models` (D11a). Every dependency is a double: no test reads
// the user's ~/.ethos, touches the vault or waits on a terminal.

function plain(lines: string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

/** The user's real config, as `readRawConfig` hands it over. */
function userConfig(overrides: Partial<EthosConfig> = {}): EthosConfig {
  return {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    apiKey: '',
    personality: 'researcher',
    providers: [{ provider: 'codex', id: 'codex-gpt-terra', model: 'gpt-5.6-terra', apiKey: '' }],
    ...overrides,
  } as EthosConfig;
}

function harness(config: EthosConfig | null, overrides: Partial<MigrateCommandDeps> = {}) {
  const lines: string[] = [];
  const saved: EthosConfig[] = [];
  const asked: string[] = [];
  const deps: MigrateCommandDeps = {
    loadConfig: async () => config,
    saveConfig: async (next) => {
      saved.push(next);
    },
    confirm: async (question) => {
      asked.push(question);
      return true;
    },
    isTTY: true,
    lookupCatalog: () => undefined,
    out: (line) => lines.push(line),
    ...overrides,
  };
  return { lines, saved, asked, deps };
}

describe('ethos migrate models', () => {
  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it('prints the diff, asks, writes, and reports what it adopted', async () => {
    const h = harness(userConfig());
    await runMigrate(['models'], h.deps);

    const out = plain(h.lines);
    expect(out).toContain('+ modelRegistry.gpt-5-6-terra.provider: codex-gpt-terra');
    expect(out).toContain('+ modelRegistry.gpt-5-6-terra.modelId: gpt-5.6-terra');
    expect(out).toContain('+ modelRegistry.default: gpt-5-6-terra');
    expect(h.asked).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.modelRegistry).toEqual({
      entries: {
        'gpt-5-6-terra': {
          alias: 'gpt-5-6-terra',
          provider: 'codex-gpt-terra',
          modelId: 'gpt-5.6-terra',
        },
      },
      roles: {},
      default: 'gpt-5-6-terra',
    });
    expect(out).toContain(
      'Adopted gpt-5-6-terra → gpt-5.6-terra on provider entry codex-gpt-terra',
    );
    expect(out).toContain('Default model: gpt-5-6-terra');
    // The diff is printed BEFORE anything is written.
    expect(out.indexOf('+ modelRegistry.default')).toBeLessThan(out.indexOf('Adopted'));
    expect(process.exitCode).toBe(0);
  });

  it('--yes writes without asking, even off a terminal', async () => {
    const h = harness(userConfig(), { isTTY: false });
    await runMigrate(['models', '--yes'], h.deps);
    expect(h.asked).toEqual([]);
    expect(h.saved).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  it('refuses off a terminal without --yes, naming the exact line to run', async () => {
    const h = harness(userConfig(), { isTTY: false });
    await runMigrate(['models'], h.deps);
    expect(h.saved).toEqual([]);
    expect(h.asked).toEqual([]);
    const out = plain(h.lines);
    expect(MIGRATE_MODELS_YES).toBe('ethos migrate models --yes');
    expect(out).toContain('Run: ethos migrate models --yes');
    expect(out).toContain('+ modelRegistry.default: gpt-5-6-terra');
    expect(process.exitCode).toBe(1);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const h = harness(userConfig(), { confirm: async () => false });
    await runMigrate(['models'], h.deps);
    expect(h.saved).toEqual([]);
    expect(plain(h.lines)).toContain('Nothing written.');
  });

  it('says there is nothing to import when the registry already has every chain model', async () => {
    const h = harness(
      userConfig({
        modelRegistry: {
          entries: {
            terra: { alias: 'terra', provider: 'codex-gpt-terra', modelId: 'gpt-5.6-terra' },
          },
          default: 'terra',
          roles: {},
        },
      }),
    );
    await runMigrate(['models'], h.deps);
    expect(plain(h.lines)).toContain('Nothing to import');
    expect(h.asked).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('writes an explicit id for an entry that has none', async () => {
    const h = harness(
      userConfig({
        provider: 'openai',
        model: 'gpt-4o',
        providers: [{ provider: 'openai', model: 'gpt-4o', apiKey: '' }],
      }),
    );
    await runMigrate(['models', '--yes'], h.deps);
    expect(h.saved[0]?.providers?.[0]?.id).toBe('openai');
    const out = plain(h.lines);
    expect(out).toContain('+ providers.0.id: openai');
    expect(out).toContain('Made provider ids explicit: openai');
  });

  it('fails without a config, and prints usage for anything but `models`', async () => {
    const missing = harness(null);
    await runMigrate(['models'], missing.deps);
    expect(plain(missing.lines)).toContain('No config found');
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    const usage = harness(userConfig());
    await runMigrate(['personalities'], usage.deps);
    expect(plain(usage.lines)).toContain('Usage: ethos migrate models');
    expect(process.exitCode).toBe(1);
    expect(usage.saved).toEqual([]);
  });
});
