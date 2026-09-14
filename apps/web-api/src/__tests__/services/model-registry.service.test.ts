// Settings → Models writes (plan/phases/model-registry.md T2.2, T2.7, T2.12).
//
// Real ConfigRepository over InMemoryStorage — the writer every registry action
// goes through — and a fake personality registry, so a repoint's personality
// rewrites and its single config.yaml write are both observable.

import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { ModelTierConfig } from '@ethosagent/types';
import { ModelTestRateLimiter, type ProbeProviderConfig } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import {
  type ModelRegistryPersonalities,
  ModelRegistryService,
} from '../../services/model-registry.service';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

const CONFIG = [
  'provider: anthropic',
  'model: claude-sonnet-5',
  'personality: researcher',
  'providers.0.provider: anthropic',
  'providers.0.id: anthropic-work',
  'providers.0.apiKey: sk-work',
  'providers.1.provider: ollama',
  'providers.1.id: local',
  'providers.1.baseUrl: http://127.0.0.1:11434/v1',
  'providers.2.provider: openai',
  'modelRegistry.opus.provider: anthropic-work',
  'modelRegistry.opus.modelId: claude-opus-5',
  'modelRegistry.sonnet.provider: anthropic-work',
  'modelRegistry.sonnet.modelId: claude-sonnet-5',
  'modelRegistry.qwen.provider: local',
  'modelRegistry.qwen.modelId: qwen2.5-coder:32b',
  'modelRegistry.default: sonnet',
  'modelRegistry.roles.deep: opus',
  'modelRouting.writer: opus',
];

interface FakePersonality {
  id: string;
  model?: string | ModelTierConfig;
  voiceModel?: string;
  builtin: boolean;
}

const PERSONALITIES: FakePersonality[] = [
  { id: 'reviewer', model: 'opus', builtin: false },
  {
    id: 'engineer',
    model: { trivial: 'trivial', default: 'default', deep: 'opus' },
    builtin: true,
  },
  { id: 'writer', model: 'default', voiceModel: 'opus', builtin: false },
  { id: 'researcher', builtin: false },
];

async function harness(lines: string[] = CONFIG) {
  const storage = new InMemoryStorage();
  await storage.mkdir(DATA);
  await storage.write(PATH, `${lines.join('\n')}\n`);
  let configWrites = 0;
  const writeAtomic = storage.writeAtomic.bind(storage);
  storage.writeAtomic = async (...args: Parameters<typeof writeAtomic>) => {
    if (args[0] === PATH) configWrites++;
    return writeAtomic(...args);
  };

  const store = new Map(PERSONALITIES.map((p) => [p.id, { ...p }]));
  const personalityWrites: Array<{ id: string; patch: unknown }> = [];
  const personalities: ModelRegistryPersonalities = {
    refresh: async () => {},
    list: () =>
      [...store.values()].map((p) => ({
        id: p.id,
        model: p.model,
        voiceModel: p.voiceModel,
        builtin: p.builtin,
      })),
    setModel: async (id, patch) => {
      personalityWrites.push({ id, patch });
      const p = store.get(id);
      if (!p) throw new Error(`no personality ${id}`);
      if (patch.model !== undefined) p.model = patch.model;
      if (patch.voiceModel !== undefined) p.voiceModel = patch.voiceModel;
    },
  };

  const secrets = new InMemorySecretsResolver();
  const probed: ProbeProviderConfig[] = [];
  const svc = new ModelRegistryService({
    readConfig: async () => {
      const src = await storage.read(PATH);
      return src === null ? null : parseConfigYaml(src);
    },
    config: new ConfigRepository({ dataDir: DATA, storage, secrets }),
    personalities,
    secrets,
    limiter: new ModelTestRateLimiter(),
    probe: async (cfg) => {
      probed.push(cfg);
      return { ok: true, latencyMs: 7 };
    },
  });
  const file = async () => parseConfigYaml((await storage.read(PATH)) ?? '');
  return {
    svc,
    file,
    store,
    probed,
    personalityWrites,
    configWrites: () => configWrites,
  };
}

describe('modelRegistry.list', () => {
  it('lists entries in file order with credential status, provider entries and referents', async () => {
    const { svc } = await harness();
    const out = await svc.list();

    expect(out.entries.map((e) => [e.alias, e.credential])).toEqual([
      ['opus', 'set'],
      ['sonnet', 'set'],
      // ollama is self-hosted: no key is a legitimate state, not a missing one.
      ['qwen', 'not_needed'],
    ]);
    expect(out.default).toBe('sonnet');
    expect(out.roles).toEqual({ trivial: null, default: null, deep: 'opus', dreaming: null });
    expect(out.routing).toEqual({ writer: 'opus' });
    expect(out.problems).toEqual([]);

    const openai = out.providerEntries.find((p) => p.provider === 'openai');
    expect(openai).toMatchObject({
      key: 'openai-2',
      index: 2,
      explicitId: false,
      referenceable: false,
      credential: 'missing',
      failover: true,
    });
    expect(openai?.reason).toContain('providers.2.id');
    expect(out.providerEntries.find((p) => p.key === 'local')?.referenceable).toBe(true);

    // No secret value ever leaves the service.
    expect(JSON.stringify(out)).not.toContain('sk-work');

    expect(out.entries.find((e) => e.alias === 'opus')?.referents).toEqual([
      { kind: 'personality', personalityId: 'reviewer', field: 'model', readOnly: false },
      { kind: 'personality', personalityId: 'engineer', field: 'model.deep', readOnly: true },
      { kind: 'personality', personalityId: 'writer', field: 'voice.model', readOnly: false },
      { kind: 'role', role: 'deep' },
      { kind: 'routing', personalityId: 'writer' },
    ]);
  });

  it('lists apiVersion for azure and region/awsProfile for bedrock, and never a secret', async () => {
    const { svc } = await harness([
      'providers.0.provider: azure',
      'providers.0.id: azure-eu',
      'providers.0.apiKey: sk-azure-secret',
      'providers.0.baseUrl: https://eu.openai.azure.com',
      'providers.0.apiVersion: 2024-10-21',
      'providers.1.provider: bedrock',
      'providers.1.id: bedrock-us',
      'providers.1.region: us-west-2',
      'providers.1.awsProfile: sso-dev',
      'providers.2.provider: anthropic',
      'providers.2.id: anthropic-work',
      'providers.2.apiKey: sk-work',
    ]);
    const out = await svc.list();
    const pick = (key: string) => {
      const p = out.providerEntries.find((e) => e.key === key);
      return p && { apiVersion: p.apiVersion, region: p.region, awsProfile: p.awsProfile };
    };
    expect(pick('azure-eu')).toEqual({ apiVersion: '2024-10-21', region: null, awsProfile: null });
    expect(pick('bedrock-us')).toEqual({
      apiVersion: null,
      region: 'us-west-2',
      awsProfile: 'sso-dev',
    });
    expect(pick('anthropic-work')).toEqual({ apiVersion: null, region: null, awsProfile: null });

    for (const view of out.providerEntries) expect(view).not.toHaveProperty('apiKey');
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('sk-azure-secret');
    expect(wire).not.toContain('sk-work');
  });
});

describe('modelRegistry.upsert', () => {
  it('upsert refuses a reserved alias name', async () => {
    const h = await harness();
    const out = await h.svc.upsert({
      mode: 'create',
      alias: 'deep',
      provider: 'anthropic-work',
      modelId: 'claude-opus-5',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('invalid_entry');
    expect(out.problems.map((p) => p.code)).toEqual(['reserved_alias']);
    // Names the offender and the configured set.
    expect(out.message).toContain('"deep"');
    expect(out.message).toContain('Configured models: opus, sonnet, qwen');
    expect(h.configWrites()).toBe(0);
  });

  it('refuses a duplicate create, an update of a missing alias, and an id-less provider entry', async () => {
    const h = await harness();
    const dup = await h.svc.upsert({
      mode: 'create',
      alias: 'opus',
      provider: 'local',
      modelId: 'x',
    });
    expect(dup.ok === false && dup.code).toBe('duplicate_alias');

    const missing = await h.svc.upsert({
      mode: 'update',
      alias: 'nope',
      provider: 'local',
      modelId: 'x',
    });
    expect(missing.ok === false && missing.code).toBe('unknown_alias');

    const derived = await h.svc.upsert({
      mode: 'create',
      alias: 'gpt',
      provider: 'openai-2',
      modelId: 'gpt-5',
    });
    expect(derived.ok).toBe(false);
    if (derived.ok) return;
    expect(derived.problems.map((p) => [p.code, p.fix])).toEqual([
      ['derived_provider_key', 'providers.2.id: openai-2'],
    ]);

    const empty = await h.svc.upsert({
      mode: 'create',
      alias: 'blank',
      provider: 'local',
      modelId: ' ',
    });
    expect(empty.ok === false && empty.problems.map((p) => p.code)).toEqual(['missing_model_id']);
    expect(h.configWrites()).toBe(0);
  });

  it('creates and updates an entry, keeps fallbacks, and preserves every other line', async () => {
    const h = await harness();
    expect(
      await h.svc.upsert({
        mode: 'create',
        alias: 'llama',
        provider: 'local',
        modelId: 'llama3.3',
        label: 'local: big',
        contextWindow: 131072,
      }),
    ).toEqual({ ok: true });
    expect((await h.file()).modelRegistry?.entries.llama).toEqual({
      alias: 'llama',
      provider: 'local',
      modelId: 'llama3.3',
      label: 'local: big',
      contextWindow: 131072,
    });

    expect(
      await h.svc.upsert({ mode: 'update', alias: 'llama', provider: 'local', modelId: 'llama4' }),
    ).toEqual({ ok: true });
    const cfg = await h.file();
    // Update REPLACES the display fields — the omitted label and window are cleared.
    expect(cfg.modelRegistry?.entries.llama).toEqual({
      alias: 'llama',
      provider: 'local',
      modelId: 'llama4',
    });
    expect(Object.keys(cfg.modelRegistry?.entries ?? {})).toEqual([
      'opus',
      'sonnet',
      'qwen',
      'llama',
    ]);
    expect(cfg.modelRegistry?.default).toBe('sonnet');
    expect(cfg.modelRouting).toEqual({ writer: 'opus' });
  });

  it('the first entry of an empty registry becomes the default', async () => {
    const h = await harness(CONFIG.filter((l) => !l.startsWith('model')));
    expect(
      await h.svc.upsert({ mode: 'create', alias: 'qwen', provider: 'local', modelId: 'qwen3' }),
    ).toEqual({ ok: true });
    expect((await h.file()).modelRegistry?.default).toBe('qwen');
  });
});

describe('modelRegistry.setDefault / setRole / setRouting', () => {
  it('writes and deletes bindings, refusing what does not resolve', async () => {
    const h = await harness();
    expect(await h.svc.setDefault({ alias: 'qwen' })).toEqual({ ok: true });
    expect((await h.file()).modelRegistry?.default).toBe('qwen');
    expect((await h.svc.setDefault({ alias: 'gone' })).ok).toBe(false);

    expect(await h.svc.setRole({ role: 'trivial', alias: 'qwen' })).toEqual({ ok: true });
    expect(await h.svc.setRole({ role: 'deep', alias: null })).toEqual({ ok: true });
    expect((await h.file()).modelRegistry?.roles).toEqual({ trivial: 'qwen' });

    const bad = await h.svc.setRouting({ personalityId: 'reviewer', declaration: 'claude-opus-5' });
    expect(bad.ok === false && bad.code).toBe('invalid_declaration');
    expect(bad.ok === false && bad.message).toContain('opus');
    const who = await h.svc.setRouting({ personalityId: 'ghost', declaration: 'deep' });
    expect(who.ok === false && who.code).toBe('unknown_personality');

    expect(await h.svc.setRouting({ personalityId: 'reviewer', declaration: 'deep' })).toEqual({
      ok: true,
    });
    expect(await h.svc.setRouting({ personalityId: 'writer', declaration: null })).toEqual({
      ok: true,
    });
    expect((await h.file()).modelRouting).toEqual({ reviewer: 'deep' });
  });
});

describe('modelRegistry.remove', () => {
  it('remove refuses an alias a personality or a role binding references, and names them', async () => {
    const h = await harness();
    const out = await h.svc.remove({ alias: 'opus' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('referenced');
    expect(out.referents).toEqual([
      { kind: 'personality', personalityId: 'reviewer', field: 'model', readOnly: false },
      { kind: 'personality', personalityId: 'engineer', field: 'model.deep', readOnly: true },
      { kind: 'personality', personalityId: 'writer', field: 'voice.model', readOnly: false },
      { kind: 'role', role: 'deep' },
      { kind: 'routing', personalityId: 'writer' },
    ]);
    expect(h.configWrites()).toBe(0);
    expect(h.personalityWrites).toEqual([]);
    expect((await h.file()).modelRegistry?.entries.opus).toBeDefined();
  });

  it('"Repoint them to…" rewrites every referent in one write', async () => {
    const h = await harness();
    const out = await h.svc.remove({ alias: 'opus', repointTo: 'sonnet' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // ONE config.yaml write carries the removal and every config-side referent.
    expect(h.configWrites()).toBe(1);
    const cfg = await h.file();
    expect(Object.keys(cfg.modelRegistry?.entries ?? {})).toEqual(['sonnet', 'qwen']);
    expect(cfg.modelRegistry?.roles).toEqual({ deep: 'sonnet' });
    expect(cfg.modelRouting).toEqual({ writer: 'sonnet' });

    // Each writable personality rewritten once; the built-in is left alone.
    expect(h.personalityWrites).toEqual([
      { id: 'reviewer', patch: { model: 'sonnet' } },
      { id: 'writer', patch: { voiceModel: 'sonnet' } },
    ]);
    expect(h.store.get('engineer')?.model).toEqual({
      trivial: 'trivial',
      default: 'default',
      deep: 'opus',
    });

    expect(out.repointedTo).toBe('sonnet');
    expect(out.needsAttention).toEqual([
      { kind: 'personality', personalityId: 'engineer', field: 'model.deep', readOnly: true },
    ]);
    expect(out.rewritten).toHaveLength(4);
  });

  it('"Remove anyway" leaves the referents needing attention, not silently repointed', async () => {
    const h = await harness();
    const out = await h.svc.remove({ alias: 'opus', force: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cfg = await h.file();
    expect(cfg.modelRegistry?.entries.opus).toBeUndefined();
    // Nothing repointed: the binding and the routing still name the removed alias,
    // so they refuse at turn time (D6/D14) instead of running on something else.
    expect(cfg.modelRegistry?.roles).toEqual({ deep: 'opus' });
    expect(cfg.modelRouting).toEqual({ writer: 'opus' });
    expect(h.personalityWrites).toEqual([]);
    expect(out.rewritten).toEqual([]);
    expect(out.needsAttention).toHaveLength(5);
    expect((await h.svc.list()).problems.map((p) => p.code)).toEqual(['unknown_role_binding']);
  });

  it('removes an unreferenced alias outright and refuses a bad repoint target', async () => {
    const h = await harness();
    const bad = await h.svc.remove({ alias: 'opus', repointTo: 'opus' });
    expect(bad.ok === false && bad.code).toBe('invalid_repoint');
    const out = await h.svc.remove({ alias: 'qwen' });
    expect(out).toEqual({
      ok: true,
      alias: 'qwen',
      repointedTo: null,
      rewritten: [],
      needsAttention: [],
    });
  });
});

describe('modelRegistry.test / testAll', () => {
  it('tests an unsaved model through the same probe, rate-limited on providerKey + modelId', async () => {
    const h = await harness();
    const out = await h.svc.test({ providerKey: 'local', modelId: 'llama3.3' }, 'cookie');
    expect(out).toEqual({
      state: 'ok',
      providerKey: 'local',
      provider: 'ollama',
      modelId: 'llama3.3',
      latencyMs: 7,
    });
    expect(h.probed[0]).toMatchObject({
      provider: 'ollama',
      model: 'llama3.3',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });

    const again = await h.svc.test({ providerKey: 'local', modelId: 'llama3.3' }, 'cookie');
    expect(again.state).toBe('rate_limited');
    // A different model on the same entry, and a saved alias, are different buckets.
    expect((await h.svc.test({ providerKey: 'local', modelId: 'phi4' }, 'cookie')).state).toBe(
      'ok',
    );
    expect((await h.svc.test({ alias: 'qwen' }, 'cookie')).state).toBe('ok');
    expect(h.probed).toHaveLength(3);
  });

  it('testAll probes one alias per provider entry the registry references', async () => {
    const h = await harness();
    const { results } = await h.svc.testAll('cookie');
    expect(results.map((r) => [r.providerKey, r.aliases, r.outcome.state])).toEqual([
      ['anthropic-work', ['opus', 'sonnet'], 'ok'],
      ['local', ['qwen'], 'ok'],
    ]);
    expect(h.probed.map((p) => p.model).sort()).toEqual(['claude-opus-5', 'qwen2.5-coder:32b']);
  });
});
