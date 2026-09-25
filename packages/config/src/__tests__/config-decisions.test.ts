// Plan decision-provider-jev §14 "Config": the `decisions.*` keys round-trip,
// absent keys mean no decision layer, `decisions.provider` accepts only
// `typesafe`, and per-site budgets default per R9.
// Plan decision-provider-personality §11 "Config": a global
// `decisions.sites.*` line is warned about, never read, and kept on write
// (PD5); `resolvePersonalityDecisionSite` covers every row of §4.3, R6
// included.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type DecisionsConfig,
  ethosDir,
  parseConfigYaml,
  type ResolvedDecisionsConfig,
  readRawConfig,
  resolveDecisionSiteMode,
  resolveDecisionsConfig,
  resolvePersonalityDecisionSite,
  writeConfig,
} from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];
const parse = (...lines: string[]) => parseConfigYaml([...base, ...lines].join('\n'));
const warningsOf = (...lines: string[]) => configParseNotices(parse(...lines)).warnings;

const ALL_KEYS = [
  'decisions.provider: typesafe',
  'decisions.model: jev-1.13.0',
  'decisions.baseUrl: https://eu.api.typesafe.ai',
  'decisions.timeoutMs: 3000',
  'decisions.timeouts.injection: 1500',
  'decisions.timeouts.approver: 2500',
  'decisions.timeouts.router: 400',
  'decisions.thresholds.injection: 0.9',
  'decisions.thresholds.approver.approve: 0.95',
  'decisions.thresholds.approver.deny: 0.8',
  'decisions.thresholds.router: 0.7',
];

describe('decisions.* parsing', () => {
  it('parses every key', () => {
    expect(parse(...ALL_KEYS).decisions).toEqual({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      baseUrl: 'https://eu.api.typesafe.ai',
      timeoutMs: 3000,
      timeouts: { injection: 1500, approver: 2500, router: 400 },
      thresholds: { injection: 0.9, approver: { approve: 0.95, deny: 0.8 }, router: 0.7 },
    });
    expect(warningsOf(...ALL_KEYS)).toEqual([]);
  });

  it('absent keys mean no decision layer', () => {
    expect(parse().decisions).toBeUndefined();
    // Site keys without a provider do not create a layer either (and are warned about).
    expect(parse('decisions.sites.injection: shadow').decisions).toBeUndefined();
    expect(warningsOf('decisions.sites.injection: shadow')).toEqual([
      expect.stringContaining('decisions.sites.injection: shadow is no longer read'),
    ]);
  });

  it('accepts only `typesafe` as the provider, warning on anything else', () => {
    const cfg = parse('decisions.provider: openai');
    expect(cfg.decisions).toBeUndefined();
    const { errors, warnings } = configParseNotices(cfg);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('decisions.provider: "openai"')]);
  });

  it('applies the defaults when only the provider is set', () => {
    const cfg = parse('decisions.provider: typesafe');
    expect(cfg.decisions).toEqual({ provider: 'typesafe' });
    const r = resolveDecisionsConfig({ provider: 'typesafe' });
    expect(r.model).toBe('jev-latest');
    expect(r.baseUrl).toBe('https://api.typesafe.ai');
    expect(r.timeoutMs).toBe(2000);
    // R9 built-in per-site budgets.
    expect(r.timeouts).toEqual({ injection: 2000, approver: 2000, router: 500 });
    expect(r.thresholds).toEqual({});
  });

  it('an explicit per-site timeout wins over the built-in default (R9)', () => {
    const r = resolveDecisionsConfig({
      provider: 'typesafe',
      timeoutMs: 5000,
      timeouts: { router: 300 },
    });
    expect(r.timeouts.router).toBe(300);
    expect(r.timeouts.injection).toBe(2000);
    expect(r.timeoutMs).toBe(5000);
  });

  it('drops invalid values with a warning and never errors', () => {
    const lines = [
      'decisions.provider: typesafe',
      'decisions.baseUrl: not a url',
      'decisions.timeoutMs: 0',
      'decisions.timeouts.router: 1.5',
      'decisions.thresholds.injection: 1.2',
      'decisions.thresholds.router: ""',
    ];
    const cfg = parse(...lines);
    expect(cfg.decisions).toEqual({ provider: 'typesafe' });
    const { errors, warnings } = configParseNotices(cfg);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(5);
  });
});

describe('PD5 — global `decisions.sites.*` lines are warned about and never read', () => {
  it('warns once per line, keeps the raw value, and resolves nothing from it', () => {
    const lines = [
      'decisions.provider: typesafe',
      'decisions.sites.injection: shadow',
      'decisions.sites.approver: on',
      'decisions.sites.router: maybe',
    ];
    const cfg = parse(...lines);
    expect(cfg.decisions).toEqual({
      provider: 'typesafe',
      legacySites: { injection: 'shadow', approver: 'on', router: 'maybe' },
    });
    const { errors, warnings } = configParseNotices(cfg);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe(
      'decisions.sites.injection: shadow is no longer read — decision sites are enabled per ' +
        'personality. Move it to ~/.ethos/personalities/<id>/config.yaml as ' +
        '"decisions.provider: typesafe" and "decisions.sites.injection: shadow".',
    );
    // Nothing on the resolved form carries a site mode.
    const r = resolveDecisionsConfig(cfg.decisions as DecisionsConfig);
    expect(r).not.toHaveProperty('sites');
    expect(r).not.toHaveProperty('legacySites');
    // A personality that declares nothing stays off despite the global line.
    expect(resolvePersonalityDecisionSite(undefined, 'injection', r).effective).toBe('off');
  });
});

describe('resolvePersonalityDecisionSite (plan decision-provider-personality §4.3/§4.4)', () => {
  const global = (d: Partial<DecisionsConfig> = {}): ResolvedDecisionsConfig =>
    resolveDecisionsConfig({ provider: 'typesafe', ...d });
  const allThresholds: DecisionsConfig['thresholds'] = {
    injection: 0.9,
    approver: { approve: 0.9, deny: 0.9 },
    router: 0.9,
  };

  it('undeclared: no decisions block, or no mode for the site → off', () => {
    expect(resolvePersonalityDecisionSite(undefined, 'injection', global())).toEqual({
      requested: 'off',
      effective: 'off',
      reason: 'undeclared',
      missingThresholds: [],
      timeoutMs: 2000,
    });
    expect(
      resolvePersonalityDecisionSite(
        { provider: 'typesafe', sites: { injection: 'shadow' } },
        'router',
        global(),
      ),
    ).toMatchObject({ requested: 'off', effective: 'off', reason: 'undeclared', timeoutMs: 500 });
  });

  it('an explicit `off` carries no reason', () => {
    const r = resolvePersonalityDecisionSite(
      { provider: 'typesafe', sites: { approver: 'off' } },
      'approver',
      global(),
    );
    expect(r).toEqual({
      requested: 'off',
      effective: 'off',
      missingThresholds: [],
      timeoutMs: 2000,
    });
  });

  it('no-provider: sites without decisions.provider → off (PD10)', () => {
    for (const provider of [undefined, '', '  ']) {
      const r = resolvePersonalityDecisionSite(
        { ...(provider !== undefined ? { provider } : {}), sites: { injection: 'on' } },
        'injection',
        global({ thresholds: allThresholds }),
      );
      expect(r).toMatchObject({ requested: 'on', effective: 'off', reason: 'no-provider' });
    }
  });

  it('not-configured: no global provider, or a different one → off (PD3)', () => {
    const declared = { provider: 'typesafe', sites: { injection: 'shadow' as const } };
    expect(resolvePersonalityDecisionSite(declared, 'injection', undefined)).toMatchObject({
      requested: 'shadow',
      effective: 'off',
      reason: 'not-configured',
      timeoutMs: 2000,
    });
    expect(
      resolvePersonalityDecisionSite(
        { provider: 'acme', sites: { injection: 'shadow' } },
        'injection',
        global(),
      ),
    ).toMatchObject({ effective: 'off', reason: 'not-configured' });
  });

  it('declared + configured: shadow runs shadow, on with thresholds runs on', () => {
    for (const site of ['injection', 'approver', 'router'] as const) {
      expect(
        resolvePersonalityDecisionSite(
          { provider: 'typesafe', sites: { [site]: 'shadow' } },
          site,
          global(),
        ),
      ).toMatchObject({ requested: 'shadow', effective: 'shadow', missingThresholds: [] });
      const on = resolvePersonalityDecisionSite(
        { provider: 'typesafe', sites: { [site]: 'on' } },
        site,
        global({ thresholds: allThresholds }),
      );
      expect(on).toMatchObject({ requested: 'on', effective: 'on', missingThresholds: [] });
      expect(on.reason).toBeUndefined();
    }
  });

  it('uses the global per-site budget (R9)', () => {
    const r = resolvePersonalityDecisionSite(
      { provider: 'typesafe', sites: { router: 'shadow' } },
      'router',
      global({ timeouts: { router: 300 } }),
    );
    expect(r.timeoutMs).toBe(300);
  });

  it('an out-of-union mode on a hand-built object reads as undeclared', () => {
    const r = resolvePersonalityDecisionSite(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input.
      { provider: 'typesafe', sites: { injection: 'maybe' as any } },
      'injection',
      global(),
    );
    expect(r).toMatchObject({ requested: 'off', effective: 'off', reason: 'undeclared' });
  });

  describe('R6 — `on` without its threshold key(s) runs `shadow` (threshold-missing)', () => {
    const cases: Array<{
      site: 'injection' | 'approver' | 'router';
      thresholds: DecisionsConfig['thresholds'];
      missing: string[];
    }> = [
      { site: 'injection', thresholds: {}, missing: ['decisions.thresholds.injection'] },
      { site: 'router', thresholds: {}, missing: ['decisions.thresholds.router'] },
      {
        site: 'approver',
        thresholds: {},
        missing: ['decisions.thresholds.approver.approve', 'decisions.thresholds.approver.deny'],
      },
      {
        site: 'approver',
        thresholds: { approver: { approve: 0.9 } },
        missing: ['decisions.thresholds.approver.deny'],
      },
      {
        site: 'approver',
        thresholds: { approver: { deny: 0.9 } },
        missing: ['decisions.thresholds.approver.approve'],
      },
    ];
    for (const { site, thresholds, missing } of cases) {
      it(`${site} missing ${missing.join(' + ')}`, () => {
        const r = resolvePersonalityDecisionSite(
          { provider: 'typesafe', sites: { [site]: 'on' } },
          site,
          global({ thresholds }),
        );
        expect(r).toMatchObject({
          requested: 'on',
          effective: 'shadow',
          reason: 'threshold-missing',
          missingThresholds: missing,
        });
      });
    }

    it('an out-of-range threshold counts as missing', () => {
      const cfg = parse('decisions.provider: typesafe', 'decisions.thresholds.router: 2');
      const d = cfg.decisions;
      expect(d && resolveDecisionSiteMode(d, 'router', 'on').effective).toBe('shadow');
    });

    it('config load no longer warns about R6 (it is per personality — doctor)', () => {
      expect(warningsOf('decisions.provider: typesafe')).toEqual([]);
    });
  });
});

describe('decisions.* round-trip through writeConfig', () => {
  async function seeded(lines: string[]): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), [...base, ...lines].join('\n'));
    return storage;
  }

  it('every key survives a read → write → read', async () => {
    const storage = await seeded(ALL_KEYS);
    const first = await readRawConfig(storage);
    if (!first) throw new Error('no config');
    await writeConfig(storage, first, new InMemorySecretsResolver());
    const second = await readRawConfig(storage);
    expect(second?.decisions).toEqual(first.decisions);
    const text = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    for (const line of ALL_KEYS) expect(text).toContain(line);
  });

  it('keeps global `decisions.sites.*` lines verbatim on write (PD5)', async () => {
    const legacy = [
      'decisions.sites.injection: shadow',
      'decisions.sites.approver: on',
      'decisions.sites.router: maybe',
    ];
    for (const provider of [['decisions.provider: typesafe'], []]) {
      const storage = await seeded([...provider, ...legacy]);
      const cfg = await readRawConfig(storage);
      if (!cfg) throw new Error('no config');
      await writeConfig(storage, cfg, new InMemorySecretsResolver());
      const text = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
      for (const line of legacy) expect(text.split('\n').filter((l) => l === line)).toHaveLength(1);
      expect((await readRawConfig(storage))?.decisions).toEqual(cfg.decisions);
    }
  });

  it('writes no defaults the file did not state', async () => {
    const storage = await seeded(['decisions.provider: typesafe']);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('no config');
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const text = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(text).toContain('decisions.provider: typesafe');
    expect(text).not.toContain('decisions.model');
    expect(text).not.toContain('decisions.timeouts');
  });

  it('keeps a rejected provider line verbatim instead of deleting it', async () => {
    const storage = await seeded(['decisions.provider: openai']);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('no config');
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const text = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(text).toContain('decisions.provider: openai');
  });
});
