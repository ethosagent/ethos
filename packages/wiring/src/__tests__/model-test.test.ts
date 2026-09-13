import type { EthosConfig } from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  MODEL_TEST_TIMEOUT_MS,
  ModelTestRateLimiter,
  providerEntries,
  providerEntryProbes,
  testModelAlias,
} from '../model-test';
import type { ProbeProviderConfig, ProbeProviderOutcome } from '../probe-provider';

// `testModelAlias` — the one function `ethos models test` and the
// `modelRegistry.test` RPC both call (T1.23/T1.24). The probe is injected, so
// nothing here opens a socket.

const secrets: SecretsResolver = {
  get: async (ref) => (ref === 'providers/0/apiKey' ? 'sk-from-vault' : null),
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

function config(overrides: Partial<EthosConfig> = {}): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-top',
    personality: 'assistant',
    providers: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal YAML secrets ref, not a JS template
      { provider: 'anthropic', id: 'work', apiKey: '${secrets:providers/0/apiKey}' },
      { provider: 'ollama', id: 'local', baseUrl: 'http://127.0.0.1:11434' },
    ],
    modelRegistry: {
      entries: {
        opus: { alias: 'opus', provider: 'work', modelId: 'claude-opus-5' },
        sonnet: { alias: 'sonnet', provider: 'work', modelId: 'claude-sonnet-5' },
        qwen: { alias: 'qwen', provider: 'local', modelId: 'qwen2.5-coder:32b' },
      },
      default: 'sonnet',
      roles: {},
    },
    ...overrides,
  } as EthosConfig;
}

function spyProbe(outcome: ProbeProviderOutcome = { ok: true, latencyMs: 7 }) {
  const calls: ProbeProviderConfig[] = [];
  return {
    calls,
    probe: async (cfg: ProbeProviderConfig) => {
      calls.push(cfg);
      return outcome;
    },
  };
}

describe('testModelAlias', () => {
  it('resolves the provider entry credential through the vault and bounds the probe', async () => {
    const p = spyProbe();
    const out = await testModelAlias({
      alias: 'opus',
      config: config(),
      secrets,
      caller: 'cli',
      limiter: new ModelTestRateLimiter(),
      probe: p.probe,
    });
    expect(out.state).toBe('ok');
    expect(p.calls[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: 'sk-from-vault',
      timeoutMs: MODEL_TEST_TIMEOUT_MS,
    });
  });

  it('refuses an alias whose provider entry does not exist, and names the ones that do', async () => {
    const p = spyProbe();
    const out = await testModelAlias({
      alias: 'ghost',
      config: config({
        modelRegistry: {
          entries: { ghost: { alias: 'ghost', provider: 'gone', modelId: 'x' } },
          roles: {},
        },
      }),
      secrets,
      caller: 'cli',
      limiter: new ModelTestRateLimiter(),
      probe: p.probe,
    });
    expect(out.state).toBe('unconfigured');
    expect(out.state === 'unconfigured' && out.reason).toContain('work, local');
    expect(p.calls).toEqual([]);
  });

  it('spends no rate-limit slot on an alias that could not have been probed', async () => {
    const now = 0;
    const limiter = new ModelTestRateLimiter(10_000, () => now);
    const p = spyProbe();
    const args = {
      config: config(),
      secrets,
      caller: 'cli',
      limiter,
      probe: p.probe,
    } as const;

    // Two refusals — an unknown alias, and a good alias whose vault secret is
    // missing — then a real test. Neither refusal may have consumed a window.
    expect((await testModelAlias({ ...args, alias: 'nope' })).state).toBe('unconfigured');
    expect((await testModelAlias({ ...args, alias: 'nope' })).state).toBe('unconfigured');
    const noVault: SecretsResolver = { ...secrets, get: async () => null };
    expect((await testModelAlias({ ...args, alias: 'opus', secrets: noVault })).state).toBe(
      'unconfigured',
    );
    expect((await testModelAlias({ ...args, alias: 'opus' })).state).toBe('ok');
    expect((await testModelAlias({ ...args, alias: 'opus' })).state).toBe('rate_limited');
  });

  it('reports a missing vault secret as unconfigured, not as a rejected key', async () => {
    const empty: SecretsResolver = { ...secrets, get: async () => null };
    const p = spyProbe();
    const out = await testModelAlias({
      alias: 'opus',
      config: config(),
      secrets: empty,
      caller: 'cli',
      limiter: new ModelTestRateLimiter(),
      probe: p.probe,
    });
    expect(out.state).toBe('unconfigured');
    expect(p.calls).toEqual([]);
  });
});

describe('provider entry selection', () => {
  it('treats the top-level provider as chain index 0 when there is no chain', () => {
    const entries = providerEntries(
      config({ providers: [] as unknown as EthosConfig['providers'] }),
    );
    expect(entries.map((e) => e.key)).toEqual(['anthropic']);
    expect(entries[0]?.entry.apiKey).toBe('sk-top');
  });

  it('--all groups aliases by PROVIDER ENTRY, one representative each', () => {
    expect(providerEntryProbes(config().modelRegistry)).toEqual([
      { providerKey: 'local', alias: 'qwen', aliases: ['qwen'] },
      { providerKey: 'work', alias: 'opus', aliases: ['opus', 'sonnet'] },
    ]);
  });

  it('an empty registry yields nothing to sweep', () => {
    expect(providerEntryProbes(undefined)).toEqual([]);
    expect(providerEntryProbes({ entries: {}, roles: {} })).toEqual([]);
  });
});

describe('ModelTestRateLimiter', () => {
  it('buckets by (caller, alias) and rounds the wait up', () => {
    let now = 0;
    const limiter = new ModelTestRateLimiter(10_000, () => now);
    expect(limiter.take('a', 'opus')).toEqual({ allowed: true });
    now = 100;
    expect(limiter.take('a', 'opus')).toEqual({ allowed: false, retryAfter: 10 });
    expect(limiter.take('b', 'opus')).toEqual({ allowed: true });
    expect(limiter.take('a', 'sonnet')).toEqual({ allowed: true });
    now = 10_100;
    expect(limiter.take('a', 'opus')).toEqual({ allowed: true });
  });
});
