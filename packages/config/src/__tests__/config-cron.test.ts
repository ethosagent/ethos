import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  writeConfig,
} from '../index';

// The `cron:` section after the fire-url collapse
// (plan/phases/cron-fire-url-collapse.md). One presence-gated switch:
// `cron.fireUrl` present = external mode, absent = local mode. Nothing changes
// production behavior by default: a config with no `cron:` section at all must
// parse to `cfg.cron === undefined`, which the wiring layer
// (`buildCronTriggers`) treats as local mode.
//
// The legacy `cron.trigger.*` / `cron.arming.*` keys are no longer parsed
// (the D3 shim was removed); the last describe block pins what a
// leftover line does now.

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(
    join(ethosDir(), 'config.yaml'),
    ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...lines].join(
      '\n',
    ),
  );
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

/** The mode is derived exactly as the wiring layer derives it. */
function mode(cfg: EthosConfig): 'local' | 'external' {
  return cfg.cron?.fireUrl ? 'external' : 'local';
}

function warnings(cfg: EthosConfig): string[] {
  return configParseNotices(cfg).warnings;
}

describe('cron config surface', () => {
  afterEach(() => {
    delete process.env.ETHOS_CRON_FIRE_URL;
  });

  it("is absent when no cron: section is declared — today's behavior is unchanged", async () => {
    const cfg = await load([]);
    expect(cfg.cron).toBeUndefined();
  });

  it('parses cron.fireUrl with no warnings', async () => {
    const cfg = await load(['cron.fireUrl: https://agent.example.com/cron/fire']);
    expect(cfg.cron?.fireUrl).toBe('https://agent.example.com/cron/fire');
    expect(mode(cfg)).toBe('external');
    expect(warnings(cfg)).toEqual([]);
  });

  it('ETHOS_CRON_FIRE_URL overrides the yaml cron.fireUrl', async () => {
    process.env.ETHOS_CRON_FIRE_URL = 'https://env.example.com/cron/fire';
    const cfg = await load(['cron.fireUrl: https://yaml.example.com/cron/fire']);
    expect(cfg.cron?.fireUrl).toBe('https://env.example.com/cron/fire');
  });

  it('ETHOS_CRON_FIRE_URL alone creates the section even with no yaml key', async () => {
    process.env.ETHOS_CRON_FIRE_URL = 'https://env.example.com/cron/fire';
    const cfg = await load([]);
    expect(cfg.cron).toEqual({ fireUrl: 'https://env.example.com/cron/fire' });
  });

  it('cron.fireUrl round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        cron: { fireUrl: 'https://agent.example.com/cron/fire', maxParallelJobs: 2 },
      },
      secrets,
    );
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).toContain('cron.fireUrl: https://agent.example.com/cron/fire');
    expect(raw).toContain('cron.maxParallelJobs: 2');

    const reread = await readRawConfig(storage);
    expect(reread?.cron).toEqual({
      fireUrl: 'https://agent.example.com/cron/fire',
      maxParallelJobs: 2,
    });
  });
});

describe('cron config — removed legacy keys (shim deleted)', () => {
  const LEGACY = ['cron.trigger.local: false', 'cron.trigger.external: true'];

  it('a legacy line yields the generic "has no effect" notice and no cron config', async () => {
    const cfg = await load(LEGACY);
    expect(cfg.cron).toBeUndefined();
    expect(mode(cfg)).toBe('local');
    const notices = warnings(cfg).join('\n');
    expect(notices).toContain(
      "config.yaml: 'cron.trigger.local' has no effect — the config parser did not read it",
    );
    expect(notices).toContain("'cron.trigger.external' has no effect");
  });

  it('a legacy cron.arming line gets the same generic notice', async () => {
    const cfg = await load(['cron.arming.fireUrl: https://wake.example.com/cron/fire']);
    expect(cfg.cron).toBeUndefined();
    expect(warnings(cfg).join('\n')).toContain("'cron.arming.fireUrl' has no effect");
  });

  it('the legacy lines survive writeConfig verbatim and cron.fireUrl is not invented', async () => {
    const parsed = await load(LEGACY);
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...LEGACY].join(
        '\n',
      ),
    );
    await writeConfig(storage, parsed, secrets);
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).toContain('cron.trigger.local: false');
    expect(raw).toContain('cron.trigger.external: true');
    expect(raw).not.toContain('cron.fireUrl:');
  });

  it("the notice reaches loadConfigStrict's deprecations on the boot path", async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...LEGACY].join(
        '\n',
      ),
    );
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.deprecations.join('\n')).toContain("'cron.trigger.local' has no effect");
  });
});
