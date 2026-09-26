import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { resolveCharacterSheetDecisions } from '../decision-diagnostics';

// plan decision-provider-personality §4.5 / §8 — the one function the
// character sheet's `## Decisions` and `ethos doctor`'s per-personality rows
// read. Each site line is `resolvePersonalityDecisionSite`; this pins the two
// caller-side annotations (key, inert approver) and the no-read rules.

const BASE = ['provider: anthropic', 'model: claude-opus-4-7'];
const cfg = (...lines: string[]) => parseConfigYaml([...BASE, ...lines].join('\n'));

async function withKey(): Promise<InMemorySecretsResolver> {
  const secrets = new InMemorySecretsResolver();
  await secrets.set('providers/typesafe/apiKey', 'ts-key');
  return secrets;
}

function personality(decisions?: PersonalityConfig['decisions'], smart = false): PersonalityConfig {
  return {
    id: 'researcher',
    name: 'Researcher',
    ...(decisions ? { decisions } : {}),
    ...(smart ? { safety: { approvalMode: 'smart' } } : {}),
  };
}

describe('resolveCharacterSheetDecisions', () => {
  it('undefined — and no vault read — when the personality declares nothing', async () => {
    const secrets = await withKey();
    const get = vi.spyOn(secrets, 'get');
    expect(
      await resolveCharacterSheetDecisions(
        personality(),
        cfg('decisions.provider: typesafe'),
        secrets,
      ),
    ).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('configured: host, model, key, R6 downgrade and an undeclared site', async () => {
    const d = await resolveCharacterSheetDecisions(
      personality({ provider: 'typesafe', sites: { injection: 'shadow', approver: 'on' } }, true),
      cfg('decisions.provider: typesafe', 'decisions.thresholds.approver.approve: 0.9'),
      await withKey(),
    );
    expect(d).toEqual({
      provider: 'typesafe',
      configured: true,
      host: 'api.typesafe.ai',
      model: 'jev-latest',
      apiKeyRef: 'providers/typesafe/apiKey',
      apiKeyPresent: true,
      sites: [
        { site: 'injection', requested: 'shadow', effective: 'shadow', missingThresholds: [] },
        {
          site: 'approver',
          requested: 'on',
          effective: 'shadow',
          reason: 'threshold-missing',
          missingThresholds: ['decisions.thresholds.approver.deny'],
        },
        {
          site: 'router',
          requested: 'off',
          effective: 'off',
          reason: 'undeclared',
          missingThresholds: [],
        },
      ],
    });
  });

  it('not-configured: no global provider → every site off, and no vault read', async () => {
    const secrets = await withKey();
    const get = vi.spyOn(secrets, 'get');
    const d = await resolveCharacterSheetDecisions(
      personality({ provider: 'typesafe', sites: { injection: 'shadow' } }),
      cfg(),
      secrets,
    );
    expect(d?.configured).toBe(false);
    expect(d?.host).toBeUndefined();
    expect(d?.sites[0]).toMatchObject({ effective: 'off', reason: 'not-configured' });
    expect(get).not.toHaveBeenCalled();
  });

  it('no-provider: sites without decisions.provider run off (PD10)', async () => {
    const d = await resolveCharacterSheetDecisions(
      personality({ sites: { router: 'on' } }),
      cfg('decisions.provider: typesafe', 'decisions.thresholds.router: 0.8'),
      await withKey(),
    );
    expect(d?.provider).toBeUndefined();
    expect(d?.configured).toBe(false);
    expect(d?.sites[2]).toMatchObject({ requested: 'on', effective: 'off', reason: 'no-provider' });
  });

  it('missing key and inert approver (approvalMode defaults to manual)', async () => {
    const d = await resolveCharacterSheetDecisions(
      personality({ provider: 'typesafe', sites: { approver: 'shadow' } }),
      cfg('decisions.provider: typesafe'),
      new InMemorySecretsResolver(),
    );
    expect(d?.apiKeyPresent).toBe(false);
    expect(d?.sites[1]).toMatchObject({
      site: 'approver',
      effective: 'shadow',
      inertApprovalMode: 'manual',
    });
  });
});
