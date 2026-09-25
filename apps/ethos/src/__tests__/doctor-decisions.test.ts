import { type EthosConfig, parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { checkDecisionLayer, decisionLayerLines } from '../commands/doctor';

// Plan decision-provider-jev §14 "Operator surface" (C4): `ethos doctor` names
// the provider and the HOST data goes to; a missing
// `providers/typesafe/apiKey` is named; nothing prints without a provider.
// Site enablement is per personality (plan decision-provider-personality §8):
// one row per personality that declares `decisions`, plus the warnings.

const BASE = ['provider: anthropic', 'model: claude-opus-4-7', 'personality: researcher'];
const cfg = (...lines: string[]): EthosConfig => parseConfigYaml([...BASE, ...lines].join('\n'));

function plain(lines: string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes.
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

async function withKey(): Promise<InMemorySecretsResolver> {
  const secrets = new InMemorySecretsResolver();
  await secrets.set('providers/typesafe/apiKey', 'ts-key');
  return secrets;
}

describe('ethos doctor — decision layer', () => {
  it('prints nothing when no decisions provider is configured', async () => {
    const empty = { configured: false, personalities: [], legacySites: [], warnings: [] };
    const report = await checkDecisionLayer(cfg(), await withKey(), [
      { id: 'plain', name: 'Plain' },
    ]);
    expect(report).toEqual(empty);
    expect(decisionLayerLines(report)).toEqual([]);
    expect(await checkDecisionLayer(null, await withKey())).toEqual(empty);
  });

  it('names the provider, host and model; a global site line is legacy only', async () => {
    const report = await checkDecisionLayer(
      cfg(
        'decisions.provider: typesafe',
        'decisions.baseUrl: https://api.typesafe.ai/v1/',
        'decisions.sites.injection: shadow',
      ),
      await withKey(),
    );
    expect(report).toEqual({
      configured: true,
      provider: 'typesafe',
      host: 'api.typesafe.ai',
      model: 'jev-latest',
      apiKeyRef: 'providers/typesafe/apiKey',
      apiKeyPresent: true,
      personalities: [],
      legacySites: [{ site: 'injection', value: 'shadow' }],
      warnings: [],
    });
    const out = plain(decisionLayerLines(report));
    // The legacy line's warning is the config notice doctor prints next
    // (`describeLegacyDecisionSite`), not repeated here.
    expect(out).toBe('     decisions:   typesafe → api.typesafe.ai · model jev-latest');
    expect(out).not.toContain('injection');
    expect(out).not.toContain('/v1');
  });

  it('names the missing vault ref when no key is stored', async () => {
    const report = await checkDecisionLayer(
      cfg('decisions.provider: typesafe'),
      new InMemorySecretsResolver(),
    );
    expect(report.apiKeyPresent).toBe(false);
    const out = plain(decisionLayerLines(report));
    expect(out).toContain('providers/typesafe/apiKey');
    expect(out).toContain("every site runs today's path");
  });
});

describe('ethos doctor — per-personality decision sites', () => {
  const p = (
    id: string,
    decisions?: PersonalityConfig['decisions'],
    approvalMode?: 'manual' | 'smart' | 'off',
  ): PersonalityConfig => ({
    id,
    name: id,
    ...(decisions ? { decisions } : {}),
    ...(approvalMode ? { safety: { approvalMode } } : {}),
  });

  it('one row per declaring personality, R6 sentence, undeclared ones omitted', async () => {
    const report = await checkDecisionLayer(
      cfg(
        'decisions.provider: typesafe',
        'decisions.thresholds.router: 0.8',
        'decisions.thresholds.approver.approve: 0.9',
      ),
      await withKey(),
      [
        p(
          'researcher',
          { provider: 'typesafe', sites: { injection: 'shadow', approver: 'on' } },
          'smart',
        ),
        p('engineer', { provider: 'typesafe', sites: { router: 'on' } }),
        p('plain'),
      ],
    );
    expect(report.personalities.map((r) => r.id)).toEqual(['engineer', 'researcher']);
    expect(report.warnings).toEqual([]);
    expect(plain(decisionLayerLines(report)).split('\n')).toEqual([
      '     decisions:   typesafe → api.typesafe.ai · model jev-latest',
      '                  engineer:   router on',
      '                  researcher: injection shadow · approver `on` requested, running `shadow`: `decisions.thresholds.approver.deny` missing',
    ]);
  });

  it('not-configured: names the personality and says its sites run off (PD3)', async () => {
    const report = await checkDecisionLayer(cfg(), await withKey(), [
      p('ops', { provider: 'typesafe', sites: { injection: 'shadow' } }),
    ]);
    expect(report.configured).toBe(false);
    expect(report.personalities[0]?.sites[0]).toMatchObject({
      site: 'injection',
      effective: 'off',
      reason: 'not-configured',
    });
    const out = plain(decisionLayerLines(report));
    expect(out).toContain('decisions:   no decisions.provider in config.yaml');
    expect(out).toContain('ops: injection shadow → off');
    expect(out).toContain(
      '⚠  decisions: ops names decision model "typesafe", but ~/.ethos/config.yaml has no decisions.provider — its sites run off.',
    );
  });

  it('sites without decisions.provider (PD10) and an inert approver each warn', async () => {
    const report = await checkDecisionLayer(cfg('decisions.provider: typesafe'), await withKey(), [
      p('ops', { sites: { injection: 'shadow' } }),
      p('guard', { provider: 'typesafe', sites: { approver: 'shadow' } }, 'manual'),
    ]);
    expect(report.warnings).toEqual([
      'decisions: guard enables the approver site, but approvalMode is manual — the approver runs only under smart.',
      'decisions: ops enables injection but names no decisions.provider — its sites run off. Add decisions.provider to its config.yaml.',
    ]);
    const out = plain(decisionLayerLines(report));
    expect(out).toContain('guard: approver shadow');
  });

  it('the missing-key warning is in the report and keeps its fix hint', async () => {
    const report = await checkDecisionLayer(
      cfg('decisions.provider: typesafe'),
      new InMemorySecretsResolver(),
      [p('researcher', { provider: 'typesafe', sites: { injection: 'shadow' } })],
    );
    expect(report.warnings).toEqual([
      "decisions: no key at vault ref providers/typesafe/apiKey — every site runs today's path.",
    ]);
    expect(plain(decisionLayerLines(report))).toContain(
      'ethos secrets set providers/typesafe/apiKey <value>',
    );
  });
});
