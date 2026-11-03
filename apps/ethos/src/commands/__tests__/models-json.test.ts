import type { EthosConfig } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { ModelTestRateLimiter, type ProbeProviderOutcome } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ModelsCommandDeps, runModels } from '../models';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos models test --json` prints exactly one JSON document.
// Deps are injected (no network, no real key), as in models-test.test.ts.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-models-json-');
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = 0;
  await h.teardown();
});

function config(): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-test',
    personality: 'assistant',
    providers: [{ provider: 'anthropic', id: 'anthropic-work', apiKey: 'sk-work' }],
    modelRegistry: {
      entries: {
        opus: { alias: 'opus', provider: 'anthropic-work', modelId: 'claude-opus-5' },
      },
      default: 'opus',
      roles: {},
    },
  } as EthosConfig;
}

function deps(
  outcome: ProbeProviderOutcome,
  cfg: EthosConfig | null = config(),
): ModelsCommandDeps {
  return {
    loadConfig: async () => cfg,
    secrets: new InMemorySecretsResolver(),
    limiter: new ModelTestRateLimiter(),
    probe: async () => outcome,
  };
}

describe('models --json', () => {
  it('--json success is one JSON doc', async () => {
    await runModels(['test', 'opus', '--json'], deps({ ok: true, latencyMs: 12 }));
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.results).toEqual([
      expect.objectContaining({ state: 'ok', modelId: 'claude-opus-5', latencyMs: 12 }),
    ]);
    expect(process.exitCode).toBe(0);
  });

  it('--json records a rejected key per result and exits non-zero', async () => {
    await runModels(
      ['test', '--all', '--json'],
      deps({ ok: false, reason: 'rejected', error: '401 nope' }),
    );
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.results).toEqual([
      expect.objectContaining({ state: 'rejected', error: '401 nope', covers: ['opus'] }),
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runModels(['bogus', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json with no config is one JSON doc', async () => {
    await expect(
      runModels(['test', 'opus', '--json'], deps({ ok: true, latencyMs: 1 }, null)),
    ).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('CONFIG_MISSING');
  });
});
