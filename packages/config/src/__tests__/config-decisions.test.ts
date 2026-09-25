// Plan decision-provider-jev §14 "Config": the `decisions.*` keys round-trip,
// absent keys mean no decision layer, `decisions.provider` accepts only
// `typesafe`, per-site budgets default per R9, and `on` without its threshold
// key(s) resolves to `shadow` with a warning while the parse still succeeds (R6).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type DecisionsConfig,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  resolveDecisionSiteMode,
  resolveDecisionsConfig,
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
  'decisions.sites.injection: on',
  'decisions.sites.approver: shadow',
  'decisions.sites.router: off',
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
      sites: { injection: 'on', approver: 'shadow', router: 'off' },
      thresholds: { injection: 0.9, approver: { approve: 0.95, deny: 0.8 }, router: 0.7 },
    });
    expect(warningsOf(...ALL_KEYS)).toEqual([]);
  });

  it('absent keys mean no decision layer', () => {
    expect(parse().decisions).toBeUndefined();
    // Site keys without a provider do not create a layer either.
    expect(parse('decisions.sites.injection: shadow').decisions).toBeUndefined();
  });

  it('accepts only `typesafe` as the provider, warning on anything else', () => {
    const cfg = parse('decisions.provider: openai', 'decisions.sites.injection: shadow');
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
    expect(r.sites.injection).toEqual({
      requested: 'off',
      effective: 'off',
      missingThresholds: [],
      timeoutMs: 2000,
    });
    expect(r.sites.approver.timeoutMs).toBe(2000);
    expect(r.sites.router.timeoutMs).toBe(500);
    expect(r.thresholds).toEqual({});
  });

  it('an explicit per-site timeout wins over the built-in default (R9)', () => {
    const r = resolveDecisionsConfig({
      provider: 'typesafe',
      timeoutMs: 5000,
      timeouts: { router: 300 },
    });
    expect(r.sites.router.timeoutMs).toBe(300);
    expect(r.sites.injection.timeoutMs).toBe(2000);
    expect(r.timeoutMs).toBe(5000);
  });

  it('drops invalid values with a warning and never errors', () => {
    const lines = [
      'decisions.provider: typesafe',
      'decisions.baseUrl: not a url',
      'decisions.timeoutMs: 0',
      'decisions.timeouts.router: 1.5',
      'decisions.sites.injection: maybe',
      'decisions.thresholds.injection: 1.2',
      'decisions.thresholds.router: ""',
    ];
    const cfg = parse(...lines);
    expect(cfg.decisions).toEqual({ provider: 'typesafe' });
    const { errors, warnings } = configParseNotices(cfg);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(6);
  });
});

describe('R6 — `on` without its threshold key(s) runs `shadow`', () => {
  const cases: Array<{ site: string; lines: string[]; missing: string[] }> = [
    { site: 'injection', lines: [], missing: ['decisions.thresholds.injection'] },
    { site: 'router', lines: [], missing: ['decisions.thresholds.router'] },
    {
      site: 'approver',
      lines: [],
      missing: ['decisions.thresholds.approver.approve', 'decisions.thresholds.approver.deny'],
    },
    {
      site: 'approver',
      lines: ['decisions.thresholds.approver.approve: 0.9'],
      missing: ['decisions.thresholds.approver.deny'],
    },
    {
      site: 'approver',
      lines: ['decisions.thresholds.approver.deny: 0.9'],
      missing: ['decisions.thresholds.approver.approve'],
    },
  ];

  for (const { site, lines, missing } of cases) {
    it(`${site} missing ${missing.join(' + ')}`, () => {
      let cfg: ReturnType<typeof parse> | undefined;
      expect(() => {
        cfg = parse('decisions.provider: typesafe', `decisions.sites.${site}: on`, ...lines);
      }).not.toThrow();
      const decisions = cfg?.decisions;
      expect(decisions).toBeDefined();
      if (!decisions || !cfg) return;
      const s = resolveDecisionsConfig(decisions).sites[site as 'injection'];
      expect(s.requested).toBe('on');
      expect(s.effective).toBe('shadow');
      expect(s.missingThresholds).toEqual(missing);
      const { errors, warnings } = configParseNotices(cfg);
      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`decisions.sites.${site}`);
      expect(warnings[0]).toContain('`on` requested, running `shadow`');
      for (const key of missing) expect(warnings[0]).toContain(key);
    });
  }

  it('`on` with every threshold present stays `on`, with no warning', () => {
    const d: DecisionsConfig = {
      provider: 'typesafe',
      sites: { injection: 'on', approver: 'on', router: 'on' },
      thresholds: { injection: 0.9, approver: { approve: 0.9, deny: 0.9 }, router: 0.9 },
    };
    for (const site of ['injection', 'approver', 'router'] as const) {
      expect(resolveDecisionSiteMode(d, site).effective).toBe('on');
    }
    expect(
      warningsOf(
        'decisions.provider: typesafe',
        'decisions.sites.approver: on',
        'decisions.thresholds.approver.approve: 0.9',
        'decisions.thresholds.approver.deny: 0.8',
      ),
    ).toEqual([]);
  });

  it('an out-of-range threshold counts as missing', () => {
    const cfg = parse(
      'decisions.provider: typesafe',
      'decisions.sites.router: on',
      'decisions.thresholds.router: 2',
    );
    const d = cfg.decisions;
    expect(d && resolveDecisionSiteMode(d, 'router').effective).toBe('shadow');
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
