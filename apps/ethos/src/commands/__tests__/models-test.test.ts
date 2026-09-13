import type { EthosConfig } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import {
  MODEL_TEST_TIMEOUT_MS,
  ModelTestRateLimiter,
  type ProbeProviderConfig,
  type ProbeProviderOutcome,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ModelsCommandDeps, runModels } from '../models';

// `ethos models test` (T1.23). Every dependency is injected: no test touches the
// network, a real credential, or the user's `~/.ethos`. The probe seam is the
// same one `testModelAlias` takes, so these assert the rendering and the exit
// code over a known outcome.

/** Strip ANSI so assertions read the words, not the escapes. */
function plain(lines: string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

function config(overrides: Partial<EthosConfig> = {}): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-test',
    personality: 'assistant',
    providers: [
      { provider: 'anthropic', id: 'anthropic-work', apiKey: 'sk-work' },
      { provider: 'ollama', id: 'local', baseUrl: 'http://127.0.0.1:11434' },
    ],
    modelRegistry: {
      entries: {
        opus: { alias: 'opus', provider: 'anthropic-work', modelId: 'claude-opus-5' },
        sonnet: { alias: 'sonnet', provider: 'anthropic-work', modelId: 'claude-sonnet-5' },
        haiku: { alias: 'haiku', provider: 'anthropic-work', modelId: 'claude-haiku-5' },
        qwen: { alias: 'qwen', provider: 'local', modelId: 'qwen2.5-coder:32b' },
      },
      default: 'sonnet',
      roles: {},
    },
    ...overrides,
  } as EthosConfig;
}

interface Harness {
  lines: string[];
  probed: ProbeProviderConfig[];
  deps: ModelsCommandDeps;
}

function harness(outcome: (cfg: ProbeProviderConfig) => ProbeProviderOutcome): Harness {
  const lines: string[] = [];
  const probed: ProbeProviderConfig[] = [];
  const secrets: SecretsResolver = new InMemorySecretsResolver();
  return {
    lines,
    probed,
    deps: {
      loadConfig: async () => config(),
      secrets,
      limiter: new ModelTestRateLimiter(),
      probe: async (cfg) => {
        probed.push(cfg);
        return outcome(cfg);
      },
      out: (line) => lines.push(line),
    },
  };
}

describe('ethos models test', () => {
  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it('--all tests one entry per provider entry, not one per alias', async () => {
    const h = harness(() => ({ ok: true, latencyMs: 12 }));
    await runModels(['test', '--all'], h.deps);

    // Four aliases, two provider ENTRIES — the credential belongs to the entry
    // (D2/D18), so three aliases on one key are ONE check.
    expect(h.probed.length).toBe(2);
    expect(h.probed.map((p) => p.model).sort()).toEqual(['claude-haiku-5', 'qwen2.5-coder:32b']);
    const out = plain(h.lines);
    expect(out).toContain('Testing 2 provider entries');
    expect(out).toContain('covers haiku, opus, sonnet');
    expect(process.exitCode).toBe(0);
  });

  it('a failure prints the vendor body verbatim and exits non-zero', async () => {
    // A real Anthropic 401 body, newlines and all. Nothing may reword or clip it.
    const vendor =
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\n' +
      `long tail: ${'x'.repeat(4000)}`;
    const h = harness(() => ({ ok: false, reason: 'rejected', error: vendor }));
    await runModels(['test', 'opus'], h.deps);

    const out = plain(h.lines);
    expect(out).toContain(vendor);
    expect(out).not.toContain('[truncated');
    // The surrounding sentence is ADDED, never a substitute for the body (V8).
    expect(out).toContain('the key was rejected');
    expect(out).toContain('Fix:');
    expect(process.exitCode).toBe(1);
  });

  it('an unreachable result exits zero and says it is not a verdict', async () => {
    const h = harness(() => ({
      ok: false,
      reason: 'unreachable',
      error: `timed out after ${MODEL_TEST_TIMEOUT_MS / 1000}s`,
    }));
    await runModels(['test', 'opus'], h.deps);

    expect(plain(h.lines)).toContain(
      'could not reach anthropic (timed out after 10s). This is not a bad key — try again.',
    );
    expect(process.exitCode).toBe(0);
  });

  it('a passing test prints the echoed model id only when it differs from the one requested', async () => {
    const differs = harness(() => ({
      ok: true,
      latencyMs: 340,
      echoedModel: 'claude-opus-5-20260114',
    }));
    await runModels(['test', 'opus'], differs.deps);
    const shown = plain(differs.lines);
    expect(shown).toContain('✓ claude-opus-5 · anthropic-work · 340 ms');
    expect(shown).toContain('responded as claude-opus-5-20260114');

    const same = harness(() => ({ ok: true, latencyMs: 340, echoedModel: 'claude-opus-5' }));
    await runModels(['test', 'opus'], same.deps);
    expect(plain(same.lines)).not.toContain('responded as');

    const silent = harness(() => ({ ok: true, latencyMs: 340 }));
    await runModels(['test', 'opus'], silent.deps);
    expect(plain(silent.lines)).not.toContain('responded as');
  });

  it('probes the alias’s provider entry credential, base URL and a 10s bound', async () => {
    const h = harness(() => ({ ok: true, latencyMs: 1 }));
    await runModels(['test', 'qwen'], h.deps);
    expect(h.probed[0]).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: MODEL_TEST_TIMEOUT_MS,
    });
  });

  it('refuses an unknown alias by name, probes nothing, and exits non-zero', async () => {
    const h = harness(() => ({ ok: true, latencyMs: 1 }));
    await runModels(['test', 'nope'], h.deps);
    expect(h.probed).toEqual([]);
    const out = plain(h.lines);
    expect(out).toContain('No registry alias "nope"');
    expect(out).toContain('haiku, opus, qwen, sonnet');
    expect(process.exitCode).toBe(1);
  });

  it('prints usage and exits non-zero for an unknown subcommand', async () => {
    const h = harness(() => ({ ok: true, latencyMs: 1 }));
    await runModels([], h.deps);
    expect(plain(h.lines)).toContain('Usage: ethos models test <alias>');
    expect(process.exitCode).toBe(1);
  });
});
