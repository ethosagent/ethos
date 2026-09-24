import { type EthosConfig, parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { checkDecisionLayer, decisionLayerLines } from '../commands/doctor';

// Plan decision-provider-jev §14 "Operator surface" (C4): `ethos doctor` names
// the provider, the HOST data goes to, and each `shadow`/`on` site; an R6
// downgrade reads "`on` requested, running `shadow`: … missing"; a missing
// `providers/typesafe/apiKey` is named; nothing prints without a provider.

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
    const report = await checkDecisionLayer(cfg(), await withKey());
    expect(report).toEqual({ configured: false });
    expect(decisionLayerLines(report)).toEqual([]);
    expect(await checkDecisionLayer(null, await withKey())).toEqual({ configured: false });
  });

  it('names the provider, the host of baseUrl, and each shadow/on site', async () => {
    const report = await checkDecisionLayer(
      cfg(
        'decisions.provider: typesafe',
        'decisions.baseUrl: https://api.typesafe.ai/v1/',
        'decisions.sites.injection: shadow',
        'decisions.sites.approver: off',
        'decisions.sites.router: on',
        'decisions.thresholds.router: 0.8',
      ),
      await withKey(),
    );
    expect(report).toEqual({
      configured: true,
      provider: 'typesafe',
      host: 'api.typesafe.ai',
      model: 'jev-latest',
      sites: [
        { site: 'injection', requested: 'shadow', effective: 'shadow' },
        { site: 'router', requested: 'on', effective: 'on' },
      ],
      apiKeyRef: 'providers/typesafe/apiKey',
      apiKeyPresent: true,
    });
    const out = plain(decisionLayerLines(report));
    expect(out).toBe('     decisions:   typesafe → api.typesafe.ai · injection shadow · router on');
    expect(out).not.toContain('approver');
    expect(out).not.toContain('/v1');
  });

  it('shows an R6-downgraded site as `on` requested, running `shadow`', async () => {
    const report = await checkDecisionLayer(
      cfg(
        'decisions.provider: typesafe',
        'decisions.sites.approver: on',
        'decisions.thresholds.approver.approve: 0.9',
      ),
      await withKey(),
    );
    expect(plain(decisionLayerLines(report))).toContain(
      'approver `on` requested, running `shadow`: `decisions.thresholds.approver.deny` missing',
    );
  });

  it('names the missing vault ref when no key is stored', async () => {
    const report = await checkDecisionLayer(
      cfg('decisions.provider: typesafe', 'decisions.sites.injection: shadow'),
      new InMemorySecretsResolver(),
    );
    expect(report.apiKeyPresent).toBe(false);
    const out = plain(decisionLayerLines(report));
    expect(out).toContain('providers/typesafe/apiKey');
    expect(out).toContain("every site runs today's path");
  });

  it('says so when a provider is set but every site is off', async () => {
    const report = await checkDecisionLayer(cfg('decisions.provider: typesafe'), await withKey());
    expect(plain(decisionLayerLines(report))).toBe(
      '     decisions:   typesafe → api.typesafe.ai · every site off',
    );
  });
});
