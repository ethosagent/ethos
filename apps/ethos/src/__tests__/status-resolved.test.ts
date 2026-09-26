import { describe, expect, it, vi } from 'vitest';

// B3/B8 (plan ux-feedback-and-config-clarity §6.2–6.3) — the `Resolved` block
// `ethos status` prints first and `ethos doctor` repeats at the top of its
// Config section. Rendering is pinned here over `resolveEffectiveConfig`
// (whose own resolution logic is pinned in packages/config).

vi.mock('../wiring', () => ({
  getStorage: () => ({}),
  // B8 — the dotenv-load side effect `resolveEffective` depends on: the real
  // `initSecrets` (apps/ethos/src/wiring.ts) loads ~/.ethos/.env into
  // process.env before anything resolves against it. Simulated here so the
  // seam call is observable.
  getSecretsResolver: async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-dotenv';
    return {};
  },
}));
// status.ts statically imports only `backupDirectory` from the wiring package;
// keep the heavy dependency tree out of this rendering test.
vi.mock('@ethosagent/wiring', () => ({
  backupDirectory: () => '/tmp/backups',
}));

import { type EthosConfig, parseConfigYaml, resolveEffectiveConfig } from '@ethosagent/config';
import { formatResolvedLines, resolveEffective } from '../commands/status';

const BASE: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  apiKey: '',
  personality: 'engineer',
};

function render(
  config: EthosConfig,
  env: Record<string, string | undefined>,
  vaultRefs: string[] = [],
): string {
  const resolved = resolveEffectiveConfig(config, env, { vaultRefs });
  return formatResolvedLines(resolved, { stateDirFromEnv: Boolean(env.ETHOS_STATE_DIR) }).join(
    '\n',
  );
}

describe('formatResolvedLines — the Resolved block', () => {
  it('names all five facets: state dir, config, personality, model, api key', () => {
    const out = render(BASE, { ETHOS_STATE_DIR: '/tmp/ethos-x' });
    expect(out).toContain('state dir');
    expect(out).toContain('/tmp/ethos-x');
    expect(out).toContain('(ETHOS_STATE_DIR)');
    expect(out).toContain('config');
    expect(out).toContain('/tmp/ethos-x/config.yaml');
    expect(out).toContain('personality');
    expect(out).toContain('engineer');
    expect(out).toContain('model');
    expect(out).toContain('claude-sonnet-5');
    expect(out).toContain('api key');
    expect(out).toContain('anthropic');
  });

  it('says when ETHOS_STATE_DIR is not set', () => {
    const out = render(BASE, {});
    expect(out).toContain('(ETHOS_STATE_DIR not set)');
  });

  it('labels the personality source: (personality:) and (default)', () => {
    expect(render(BASE, {})).toContain('(personality:)');
    expect(render({ ...BASE, personality: '' }, {})).toContain('(default)');
  });

  it('a parsed config whose file never set personality: renders (default), not (personality:)', () => {
    // parseConfigYaml bakes the default id into the field; the source label
    // must still be honest about who chose it.
    const cfg = parseConfigYaml(
      ['provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk'].join('\n'),
    );
    const out = render(cfg, {});
    expect(out).toContain('(default)');
    expect(out).not.toContain('(personality:)');
  });

  it('labels the model rung: (model:) and (engineer → modelRouting.engineer)', () => {
    expect(render(BASE, {})).toContain('(model:)');
    const routed = render({ ...BASE, modelRouting: { engineer: 'claude-opus-4-7' } }, {});
    expect(routed).toContain('claude-opus-4-7');
    expect(routed).toContain('(engineer → modelRouting.engineer)');
  });

  it('prints the env-overrides-vault line when both hold the key', () => {
    const out = render(BASE, { ANTHROPIC_API_KEY: 'sk-ant-x' }, ['providers/anthropic/apiKey']);
    expect(out).toContain('source: env ANTHROPIC_API_KEY, overrides vault');
  });

  it('does not claim an override when only the env var is set', () => {
    const out = render(BASE, { ANTHROPIC_API_KEY: 'sk-ant-x' }, []);
    expect(out).toContain('source: env ANTHROPIC_API_KEY');
    expect(out).not.toContain('overrides vault');
  });

  it('names the vault ref when the vault serves the key', () => {
    const out = render(BASE, {}, ['providers/anthropic/apiKey']);
    expect(out).toContain('source: vault providers/anthropic/apiKey');
  });

  it('says none found (with the set command) when env is unset and the vault lacks the ref', () => {
    const out = render(BASE, {}, []);
    expect(out).toContain('source: none found — ethos secrets set providers/anthropic/apiKey');
    expect(out).not.toContain('source: vault');
  });

  it('resolveEffective loads ~/.ethos/.env through the wiring seam before resolving (B8)', async () => {
    // The mocked getSecretsResolver above stands in for initSecrets'
    // loadDotEnv side effect: a key that lives only in .env must report
    // `source: env`, as the runtime actually resolves it.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const resolved = await resolveEffective(BASE);
      expect(resolved.apiKey.source).toBe('env');
      expect(resolved.apiKey.envVar).toBe('ANTHROPIC_API_KEY');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('suffixes the config line with the warning count', () => {
    const resolved = resolveEffectiveConfig(BASE, {}, {});
    const out = formatResolvedLines(
      { ...resolved, warnings: ["config.yaml:3 unknown key 'modle'"] },
      { stateDirFromEnv: false },
    ).join('\n');
    expect(out).toContain('(1 warning · ethos doctor)');
  });
});
