import { type EthosConfig, parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { checkDecisionLayer, decisionLayerLines } from '../commands/doctor';

// Plan decision-provider-jev §14 "Operator surface" (C4): `ethos doctor` names
// the provider and the HOST data goes to; a missing
// `providers/typesafe/apiKey` is named; nothing prints without a provider.
// Site enablement is per personality (plan decision-provider-personality);
// its doctor lines are milestone N4.

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

  it('names the provider and the host of baseUrl; global site lines list nothing', async () => {
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
    });
    const out = plain(decisionLayerLines(report));
    expect(out).toBe(
      '     decisions:   typesafe → api.typesafe.ai · sites enabled per personality',
    );
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
