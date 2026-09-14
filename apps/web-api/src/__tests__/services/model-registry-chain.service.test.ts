// Settings → Models: chain import (D11a) and provider-entry writes.
//
// Real ConfigRepository over InMemoryStorage — the writer every action goes
// through — and the real `ConfigService.deleteOrphanedSecrets` for vault
// cleanup, so single-write, key externalization and orphan deletion are all
// observed rather than assumed.

import { join } from 'node:path';
import { parseConfigYaml, secretRefFromValue } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { ModelTestRateLimiter, type ProbeProviderConfig } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';
import { ModelRegistryService } from '../../services/model-registry.service';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

function ref(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

/** The user's real config: a chain model, NO registry. */
const USER_CONFIG = [
  'provider: codex',
  'model: gpt-5.6-terra',
  'personality: researcher',
  'approvalMode: smart',
  'providers.0.provider: codex',
  'providers.0.id: codex-gpt-terra',
  'providers.0.model: gpt-5.6-terra',
  'someTool.flag: kept',
];

const CHAIN = [
  'provider: anthropic',
  'model: claude-sonnet-5',
  'personality: researcher',
  'providers.0.provider: anthropic',
  'providers.0.id: anthropic-work',
  `providers.0.apiKey: ${ref('providers/0/anthropic/apiKey')}`,
  'providers.0.model: claude-sonnet-5',
  'providers.1.provider: ollama',
  'providers.1.id: local',
  'providers.1.baseUrl: http://127.0.0.1:11434/v1',
  'providers.1.model: qwen2.5-coder:32b',
  'providers.2.provider: openai',
  `providers.2.apiKey: ${ref('providers/2/openai/apiKey')}`,
  'providers.2.region: us',
  'providers.2.customField: keep-me',
  'modelRegistry.opus.provider: anthropic-work',
  'modelRegistry.opus.modelId: claude-opus-5',
  'modelRegistry.sonnet.provider: anthropic-work',
  'modelRegistry.sonnet.modelId: claude-sonnet-5',
  'modelRegistry.qwen.provider: local',
  'modelRegistry.qwen.modelId: qwen2.5-coder:32b',
  'modelRegistry.default: sonnet',
  'modelRegistry.roles.deep: opus',
  'someTool.flag: kept',
];

async function harness(lines: string[] | null) {
  const storage = new InMemoryStorage();
  await storage.mkdir(DATA);
  if (lines) await storage.write(PATH, `${lines.join('\n')}\n`);
  let configWrites = 0;
  const writeAtomic = storage.writeAtomic.bind(storage);
  storage.writeAtomic = async (...args: Parameters<typeof writeAtomic>) => {
    if (args[0] === PATH) configWrites++;
    return writeAtomic(...args);
  };
  const secrets = new InMemorySecretsResolver();
  await secrets.set('providers/0/anthropic/apiKey', 'sk-work');
  await secrets.set('providers/2/openai/apiKey', 'sk-openai');
  const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
  const configService = new ConfigService({ config: repo, secrets });
  const probed: ProbeProviderConfig[] = [];
  const svc = new ModelRegistryService({
    readConfig: async () => {
      const src = await storage.read(PATH);
      return src === null ? null : parseConfigYaml(src);
    },
    config: repo,
    personalities: { refresh: async () => {}, list: () => [], setModel: async () => {} },
    secrets,
    limiter: new ModelTestRateLimiter(),
    probe: async (cfg) => {
      probed.push(cfg);
      return { ok: true, latencyMs: 5 };
    },
    deleteOrphanedSecrets: (refs) => configService.deleteOrphanedSecrets(refs),
    lookupCatalog: (provider, modelId) =>
      provider === 'codex' && modelId === 'gpt-5.6-terra'
        ? { label: 'everyday, balanced', contextWindow: 1_050_000 }
        : undefined,
  });
  return {
    svc,
    secrets,
    probed,
    raw: async () => {
      const current = await repo.read();
      if (!current) throw new Error('no config');
      return current;
    },
    text: async () => (await storage.read(PATH)) ?? '',
    configWrites: () => configWrites,
  };
}

describe('modelRegistry.list chainModels + importChain', () => {
  it("lists the user's chain model the registry lacks", async () => {
    const h = await harness(USER_CONFIG);
    const out = await h.svc.list();
    expect(out.entries).toEqual([]);
    expect(out.chainModels).toEqual([
      {
        providerKey: 'codex-gpt-terra',
        index: 0,
        provider: 'codex',
        modelId: 'gpt-5.6-terra',
        suggestedAlias: 'gpt-5-6-terra',
        idIsExplicit: true,
      },
    ]);
  });

  it('adopts it in one write, sets the default and preserves unrelated lines', async () => {
    const h = await harness(USER_CONFIG);
    expect(await h.svc.importChain({})).toEqual({
      ok: true,
      adopted: [
        { alias: 'gpt-5-6-terra', providerKey: 'codex-gpt-terra', modelId: 'gpt-5.6-terra' },
      ],
      defaultSet: 'gpt-5-6-terra',
      idsWritten: [],
    });
    expect(h.configWrites()).toBe(1);
    const raw = await h.raw();
    expect(raw.modelRegistry).toEqual({
      entries: {
        'gpt-5-6-terra': {
          alias: 'gpt-5-6-terra',
          provider: 'codex-gpt-terra',
          modelId: 'gpt-5.6-terra',
          label: 'everyday, balanced',
          contextWindow: 1_050_000,
        },
      },
      default: 'gpt-5-6-terra',
      roles: {},
    });
    const text = await h.text();
    for (const line of [
      'provider: codex',
      'model: gpt-5.6-terra',
      'approvalMode: smart',
      'someTool.flag: kept',
      'providers.0.id: codex-gpt-terra',
    ]) {
      expect(text).toContain(line);
    }
    const after = await h.svc.list();
    expect(after.chainModels).toEqual([]);
    expect(after.entries.map((e) => e.alias)).toEqual(['gpt-5-6-terra']);
    expect(after.problems).toEqual([]);
  });

  it('re-running the import is a no-op and writes nothing', async () => {
    const h = await harness(USER_CONFIG);
    await h.svc.importChain({});
    const before = await h.text();
    expect(await h.svc.importChain({})).toEqual({
      ok: true,
      adopted: [],
      defaultSet: null,
      idsWritten: [],
    });
    expect(h.configWrites()).toBe(1);
    expect(await h.text()).toBe(before);
  });

  it('suffixes an alias that collides with an existing one', async () => {
    const h = await harness([
      'provider: openai',
      'model: gpt-4o',
      'providers.0.provider: openai',
      'providers.0.id: personal',
      'providers.0.model: gpt-4o',
      'providers.1.provider: openai',
      'providers.1.id: work',
      'providers.1.model: gpt-4o',
      'modelRegistry.gpt-4o.provider: personal',
      'modelRegistry.gpt-4o.modelId: gpt-4o',
      'modelRegistry.default: gpt-4o',
    ]);
    expect(await h.svc.importChain({})).toEqual({
      ok: true,
      adopted: [{ alias: 'gpt-4o-work', providerKey: 'work', modelId: 'gpt-4o' }],
      defaultSet: null,
      idsWritten: [],
    });
    expect((await h.raw()).modelRegistry?.default).toBe('gpt-4o');
  });

  it('writes an explicit id for an id-less entry, and honours the key filter', async () => {
    const h = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      'providers.0.provider: anthropic',
      'providers.0.id: work',
      'providers.0.model: claude-sonnet-5',
      'providers.1.provider: openai',
      'providers.1.model: gpt-4o',
    ]);
    const listed = await h.svc.list();
    expect(listed.chainModels.map((c) => [c.providerKey, c.idIsExplicit])).toEqual([
      ['work', true],
      ['openai-1', false],
    ]);
    const result = await h.svc.importChain({ providerKeys: ['openai-1'] });
    expect(result).toEqual({
      ok: true,
      adopted: [{ alias: 'gpt-4o', providerKey: 'openai-1', modelId: 'gpt-4o' }],
      defaultSet: 'gpt-4o',
      idsWritten: ['openai-1'],
    });
    expect((await h.raw()).providers.map((p) => p.id)).toEqual(['work', 'openai-1']);
    expect(await h.text()).toContain('providers.1.id: openai-1');
    const after = await h.svc.list();
    expect(after.chainModels.map((c) => c.providerKey)).toEqual(['work']);
    expect(after.problems).toEqual([]);
  });

  it('refuses when there is no config', async () => {
    const h = await harness(null);
    expect(await h.svc.importChain({})).toMatchObject({ ok: false, code: 'config_missing' });
    expect(h.configWrites()).toBe(0);
  });
});

describe('modelRegistry.addProvider', () => {
  it('appends the entry and upserts two models in ONE write, the key in the vault', async () => {
    const h = await harness(CHAIN);
    const result = await h.svc.addProvider({
      provider: 'openrouter',
      id: 'router',
      apiKey: 'sk-router-plaintext',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ modelId: 'meta/llama-4' }, { modelId: 'qwen', label: 'qwen via router' }],
    });
    expect(result).toEqual({
      ok: true,
      providerKey: 'router',
      index: 3,
      models: [
        { alias: 'meta-llama-4', providerKey: 'router', modelId: 'meta/llama-4' },
        // `qwen` is taken, so the importer's suffix rule applies.
        { alias: 'qwen-router', providerKey: 'router', modelId: 'qwen' },
      ],
    });
    expect(h.configWrites()).toBe(1);

    const raw = await h.raw();
    const entry = raw.providers[3];
    expect(entry).toMatchObject({
      provider: 'openrouter',
      id: 'router',
      model: 'meta/llama-4',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const keyRef = secretRefFromValue(entry?.apiKey ?? '');
    expect(keyRef).not.toBeNull();
    expect(await h.secrets.get(keyRef ?? '')).toBe('sk-router-plaintext');
    expect(await h.text()).not.toContain('sk-router-plaintext');

    expect(raw.modelRegistry?.entries['qwen-router']).toEqual({
      alias: 'qwen-router',
      provider: 'router',
      modelId: 'qwen',
      label: 'qwen via router',
    });
    expect(raw.modelRegistry?.default).toBe('sonnet');
    expect((await h.svc.list()).problems).toEqual([]);
  });

  it('refuses a duplicate or illegal id and any model problem, writing nothing', async () => {
    const h = await harness(CHAIN);
    const base = { provider: 'openai', id: 'fresh', models: [{ modelId: 'gpt-4o' }] };
    const cases: Array<[Parameters<typeof h.svc.addProvider>[0], string]> = [
      [{ ...base, id: 'local' }, 'duplicate_id'],
      // A derived key names an entry too, so it cannot be claimed.
      [{ ...base, id: 'openai-2' }, 'duplicate_id'],
      [{ ...base, id: 'my router' }, 'invalid_id'],
      [{ ...base, id: '' }, 'invalid_id'],
      [{ ...base, provider: ' ' }, 'invalid_provider'],
      [{ ...base, models: [{ modelId: 'gpt-4o', alias: 'opus' }] }, 'duplicate_alias'],
      [{ ...base, models: [{ modelId: '  ' }] }, 'invalid_model'],
      [{ ...base, models: [{ modelId: 'gpt-4o' }, { modelId: 'gpt-4o' }] }, 'invalid_model'],
      [{ ...base, models: [{ modelId: 'gpt-4o', alias: 'deep' }] }, 'invalid_model'],
    ];
    for (const [input, code] of cases) {
      const result = await h.svc.addProvider(input);
      expect(result, JSON.stringify(input)).toMatchObject({ ok: false, code });
    }
    const reserved = await h.svc.addProvider({
      ...base,
      models: [{ modelId: 'gpt-4o', alias: 'deep' }],
    });
    expect(reserved.ok === false && reserved.problems.map((p) => p.code)).toEqual([
      'reserved_alias',
    ]);
    const duplicate = await h.svc.addProvider({ ...base, id: 'local' });
    expect(duplicate.ok === false && duplicate.message).toContain(
      'anthropic-work, local, openai-2',
    );
    expect(h.configWrites()).toBe(0);
  });

  it('puts a top-level-only primary at the head of the new chain', async () => {
    const h = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      `apiKey: ${ref('providers/anthropic/apiKey')}`,
    ]);
    const result = await h.svc.addProvider({
      provider: 'ollama',
      id: 'local',
      models: [{ modelId: 'qwen3' }],
    });
    expect(result).toMatchObject({ ok: true, providerKey: 'local', index: 1 });
    const raw = await h.raw();
    expect(raw.providers).toEqual([
      {
        provider: 'anthropic',
        apiKey: ref('providers/anthropic/apiKey'),
        model: 'claude-sonnet-5',
      },
      { provider: 'ollama', id: 'local', model: 'qwen3' },
    ]);
    // The registry was empty: its first model becomes the default.
    expect(raw.modelRegistry?.default).toBe('qwen3');
  });
});

describe('modelRegistry.updateProvider', () => {
  it('replaces the key through the vault, sets and clears fields, keeps the rest', async () => {
    const h = await harness(CHAIN);
    const result = await h.svc.updateProvider({
      key: 'openai-2',
      apiKey: 'sk-rotated',
      baseUrl: 'https://api.example/v1',
      region: '',
    });
    expect(result).toEqual({ ok: true, providerKey: 'openai-2', index: 2 });
    const entry = (await h.raw()).providers[2];
    expect(entry?.region).toBeUndefined();
    expect(entry?.baseUrl).toBe('https://api.example/v1');
    expect(entry?.passthrough).toEqual({ customField: 'keep-me' });
    expect(await h.secrets.get(secretRefFromValue(entry?.apiKey ?? '') ?? '')).toBe('sk-rotated');
    expect(await h.text()).not.toContain('sk-rotated');

    // An empty key never erases the stored one.
    const refBefore = entry?.apiKey;
    await h.svc.updateProvider({ key: 'openai-2', apiKey: '' });
    expect((await h.raw()).providers[2]?.apiKey).toBe(refBefore);
  });

  it('refuses an unknown key, naming the entries', async () => {
    const h = await harness(CHAIN);
    const result = await h.svc.updateProvider({ key: 'nope', baseUrl: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'unknown_provider' });
    expect(result.ok === false && result.message).toContain('anthropic-work, local, openai-2');
    expect(h.configWrites()).toBe(0);
  });

  it('entry 0 of a one-entry chain also edits the top level the runtime reads', async () => {
    const h = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      'providers.0.provider: anthropic',
      'providers.0.id: work',
      'providers.0.model: claude-sonnet-5',
    ]);
    await h.svc.updateProvider({ key: 'work', baseUrl: 'https://proxy.example' });
    const raw = await h.raw();
    expect(raw.baseUrl).toBe('https://proxy.example');
    expect(raw.providers[0]?.baseUrl).toBe('https://proxy.example');
  });
});

describe('modelRegistry.removeProvider', () => {
  it('is refused while a model references the entry, naming default, role and fallback model', async () => {
    const h = await harness(CHAIN);
    const work = await h.svc.removeProvider({ key: 'anthropic-work' });
    expect(work).toMatchObject({ ok: false, code: 'referenced', aliases: ['opus', 'sonnet'] });
    const message = work.ok === false ? work.message : '';
    expect(message).toContain('"sonnet" is the default model.');
    expect(message).toContain('"opus" is bound to the deep role.');
    expect(message).toContain(`"sonnet" is this provider's fallback model (providers.0.model).`);

    const local = await h.svc.removeProvider({ key: 'local' });
    expect(local).toMatchObject({ ok: false, code: 'referenced', aliases: ['qwen'] });
    expect(local.ok === false && local.message).toContain('providers.1.model');
    expect(h.configWrites()).toBe(0);
  });

  it('removes an unreferenced entry, re-indexes, and deletes its orphaned vault key', async () => {
    const h = await harness(CHAIN);
    expect(await h.svc.removeProvider({ key: 'openai-2' })).toEqual({
      ok: true,
      providerKey: 'openai-2',
      index: 2,
    });
    const raw = await h.raw();
    expect(raw.providers.map((p) => p.id)).toEqual(['anthropic-work', 'local']);
    expect(await h.text()).not.toContain('customField');
    expect(await h.secrets.get('providers/2/openai/apiKey')).toBeNull();
    expect(await h.secrets.get('providers/0/anthropic/apiKey')).toBe('sk-work');
  });

  it("refuses to remove the deployment's only provider", async () => {
    const chainOfOne = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      'providers.0.provider: anthropic',
      'providers.0.id: work',
    ]);
    expect(await chainOfOne.svc.removeProvider({ key: 'work' })).toMatchObject({
      ok: false,
      code: 'last_provider',
    });
    const topOnly = await harness(['provider: anthropic', 'model: claude-sonnet-5']);
    expect(await topOnly.svc.removeProvider({ key: 'anthropic' })).toMatchObject({
      ok: false,
      code: 'last_provider',
    });
  });

  it('removing the head of a two-entry chain moves the top level to the new head', async () => {
    const h = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      'providers.0.provider: anthropic',
      'providers.0.id: work',
      'providers.0.model: claude-sonnet-5',
      'providers.1.provider: ollama',
      'providers.1.id: local',
      'providers.1.baseUrl: http://127.0.0.1:11434/v1',
      'providers.1.model: qwen3',
    ]);
    expect(await h.svc.removeProvider({ key: 'work' })).toMatchObject({ ok: true });
    const raw = await h.raw();
    expect([raw.provider, raw.model, raw.baseUrl]).toEqual([
      'ollama',
      'qwen3',
      'http://127.0.0.1:11434/v1',
    ]);
  });
});

describe('modelRegistry.moveProvider', () => {
  it('re-indexes, preserving every field and passthrough', async () => {
    const h = await harness(CHAIN);
    const before = (await h.raw()).providers;
    expect(await h.svc.moveProvider({ key: 'openai-2', direction: 'up' })).toEqual({
      ok: true,
      // An id-less entry's derived key moves with it.
      providerKey: 'openai-1',
      index: 1,
    });
    expect((await h.raw()).providers).toEqual([before[0], before[2], before[1]]);
    const text = await h.text();
    expect(text).toContain('providers.1.customField: keep-me');
    expect(text).toContain('providers.1.region: us');
    expect(text).toContain('providers.2.id: local');
    expect(text).toContain('someTool.flag: kept');
  });

  it('refuses a move past either end', async () => {
    const h = await harness(CHAIN);
    expect(await h.svc.moveProvider({ key: 'anthropic-work', direction: 'up' })).toMatchObject({
      ok: false,
      code: 'cannot_move',
    });
    expect(await h.svc.moveProvider({ key: 'openai-2', direction: 'down' })).toMatchObject({
      ok: false,
      code: 'cannot_move',
    });
    expect(h.configWrites()).toBe(0);
  });
});

describe('modelRegistry.setProviderFailover', () => {
  it('writes failover: false and removes it again', async () => {
    const h = await harness(CHAIN);
    await h.svc.setProviderFailover({ key: 'local', failover: false });
    expect((await h.raw()).providers[1]?.failover).toBe(false);
    expect(await h.text()).toContain('providers.1.failover: false');
    await h.svc.setProviderFailover({ key: 'local', failover: true });
    expect((await h.raw()).providers[1]?.failover).toBeUndefined();
  });

  it('refuses failover: false for a top-level-only provider', async () => {
    const h = await harness(['provider: anthropic', 'model: claude-sonnet-5']);
    expect(await h.svc.setProviderFailover({ key: 'anthropic', failover: false })).toMatchObject({
      ok: false,
      code: 'not_in_chain',
    });
  });
});

describe('modelRegistry.setFallbackModel', () => {
  it("writes the alias's modelId, and removes the line on null", async () => {
    const h = await harness(CHAIN);
    expect(await h.svc.setFallbackModel({ key: 'anthropic-work', alias: 'opus' })).toEqual({
      ok: true,
      providerKey: 'anthropic-work',
      index: 0,
    });
    const raw = await h.raw();
    expect(raw.providers[0]?.model).toBe('claude-opus-5');
    // A chain of two or more runs on the chain: the top level is not touched.
    expect(raw.model).toBe('claude-sonnet-5');

    await h.svc.setFallbackModel({ key: 'local', alias: null });
    expect((await h.raw()).providers[1]?.model).toBeUndefined();
  });

  it('refuses a model on another provider entry, naming the ones it could pick', async () => {
    const h = await harness(CHAIN);
    const result = await h.svc.setFallbackModel({ key: 'anthropic-work', alias: 'qwen' });
    expect(result).toMatchObject({
      ok: false,
      code: 'cross_provider_alias',
      aliases: ['opus', 'sonnet'],
    });
    expect(result.ok === false && result.message).toContain('"local"');
    expect(await h.svc.setFallbackModel({ key: 'local', alias: 'nope' })).toMatchObject({
      ok: false,
      code: 'unknown_alias',
    });
    expect(h.configWrites()).toBe(0);
  });

  it('entry 0 of a one-entry chain also writes the top-level model', async () => {
    const h = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      'providers.0.provider: anthropic',
      'providers.0.id: work',
      'providers.0.model: claude-sonnet-5',
      'modelRegistry.opus.provider: work',
      'modelRegistry.opus.modelId: claude-opus-5',
    ]);
    await h.svc.setFallbackModel({ key: 'work', alias: 'opus' });
    const raw = await h.raw();
    expect([raw.model, raw.providers[0]?.model]).toEqual(['claude-opus-5', 'claude-opus-5']);
  });
});

describe('modelRegistry.testProvider', () => {
  it("probes the entry's own model with its stored credential, limited per entry", async () => {
    const h = await harness(CHAIN);
    expect(await h.svc.testProvider({ providerKey: 'anthropic-work' }, 'cookie')).toEqual({
      state: 'ok',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      latencyMs: 5,
    });
    expect(h.probed[0]).toMatchObject({ model: 'claude-sonnet-5', apiKey: 'sk-work' });
    expect(await h.svc.testProvider({ providerKey: 'anthropic-work' }, 'cookie')).toMatchObject({
      state: 'rate_limited',
      providerKey: 'anthropic-work',
    });
    // A model test on the same entry is its own bucket.
    expect(await h.svc.test({ alias: 'opus' }, 'cookie')).toMatchObject({ state: 'ok' });
    expect(h.probed).toHaveLength(2);
  });

  it('falls back to the first registry model, and is unconfigured with neither', async () => {
    const h = await harness([
      'provider: anthropic',
      'model: claude-sonnet-5',
      'providers.0.provider: anthropic',
      'providers.0.id: work',
      `providers.0.apiKey: ${ref('providers/0/anthropic/apiKey')}`,
      'providers.1.provider: openai',
      'providers.1.id: bare',
      'modelRegistry.opus.provider: work',
      'modelRegistry.opus.modelId: claude-opus-5',
    ]);
    expect(await h.svc.testProvider({ providerKey: 'work' }, 'cookie')).toMatchObject({
      state: 'ok',
      modelId: 'claude-opus-5',
    });
    const bare = await h.svc.testProvider({ providerKey: 'bare' }, 'cookie');
    expect(bare).toMatchObject({ state: 'unconfigured', providerKey: 'bare' });
    expect(bare.state === 'unconfigured' && bare.reason).toContain('no model to probe with');
    expect(await h.svc.testProvider({ providerKey: 'nope' }, 'cookie')).toMatchObject({
      state: 'unconfigured',
    });
    expect(h.probed).toHaveLength(1);
  });
});
