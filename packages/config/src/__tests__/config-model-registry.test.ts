// The `modelRegistry.*` namespace (plan/phases/model-registry.md D2) and the
// two `providers.<n>.*` fields it leans on: `id` (D2/D24) and `failover`
// (D23b). Parse and serialize are one pair — a line the parser claims and the
// serializer cannot produce would be kept verbatim by `unexpressibleLines`
// forever, undeletable through `writeConfig`.
//
// This task is the CODEC only. Nothing here refuses a bad registry: an unknown
// provider key, a missing `modelId`, a reserved alias, a dangling `default` and
// a cross-provider fallback are all `validateModelRegistry`'s (T1.3), and the
// codec deliberately lets each one through so that function can name it.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  deriveProviderKey,
  ethosDir,
  loadConfigStrict,
  parseProviderChain,
  readRawConfig,
  renderProviderChain,
  writeConfig,
} from '../index';

const path = join(ethosDir(), 'config.yaml');

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(path, yaml);
  return readRawConfig(storage);
}

const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

describe('modelRegistry config parsing', () => {
  it('parses an entry with every field', async () => {
    const cfg = await load(
      [
        ...base,
        'modelRegistry.sonnet.provider: anthropic-work',
        'modelRegistry.sonnet.modelId: claude-sonnet-5',
        'modelRegistry.sonnet.label: everyday driver',
        'modelRegistry.sonnet.contextWindow: 200000',
        'modelRegistry.sonnet.costPer1kInput: 0.003',
        'modelRegistry.sonnet.costPer1kOutput: 0.015',
        'modelRegistry.sonnet.fallbacks: sonnet-eu, sonnet-old',
      ].join('\n'),
    );
    expect(cfg?.modelRegistry?.entries.sonnet).toEqual({
      alias: 'sonnet',
      provider: 'anthropic-work',
      modelId: 'claude-sonnet-5',
      label: 'everyday driver',
      contextWindow: 200000,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      fallbacks: ['sonnet-eu', 'sonnet-old'],
    });
  });

  it('parses modelRegistry.default and modelRegistry.roles.<role> without treating them as aliases', async () => {
    const cfg = await load(
      [
        ...base,
        'modelRegistry.sonnet.provider: anthropic-work',
        'modelRegistry.sonnet.modelId: claude-sonnet-5',
        'modelRegistry.default: sonnet',
        'modelRegistry.roles.deep: opus',
        'modelRegistry.roles.trivial: haiku',
      ].join('\n'),
    );
    expect(Object.keys(cfg?.modelRegistry?.entries ?? {})).toEqual(['sonnet']);
    expect(cfg?.modelRegistry?.default).toBe('sonnet');
    expect(cfg?.modelRegistry?.roles).toEqual({ deep: 'opus', trivial: 'haiku' });
  });

  // Roles and aliases share one namespace, so `modelRegistry.roles.<x>` is a
  // role binding only for the four real roles; anything else is an alias called
  // `roles`. Nothing refuses the alias `default` here — T1.3 does.
  it('reads an unknown roles.<name> as an alias field, not as a role binding', async () => {
    const cfg = await load([...base, 'modelRegistry.roles.provider: anthropic-work'].join('\n'));
    expect(cfg?.modelRegistry?.roles).toEqual({});
    expect(cfg?.modelRegistry?.entries.roles?.provider).toBe('anthropic-work');
  });

  it('an unknown modelRegistry leaf is preserved, not claimed and not dropped', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      path,
      `${[
        ...base,
        'modelRegistry.sonnet.provider: anthropic-work',
        'modelRegistry.sonnet.modelId: claude-sonnet-5',
        'modelRegistry.sonnet.maxTokens: 4096',
      ].join('\n')}\n`,
    );
    const cfg = await readRawConfig(storage);
    // Not claimed: it is on no entry, and it did not invent one.
    expect(cfg?.modelRegistry?.entries.sonnet).toEqual({
      alias: 'sonnet',
      provider: 'anthropic-work',
      modelId: 'claude-sonnet-5',
    });
    if (!cfg) throw new Error('config did not parse');
    // Not dropped: an unrelated write keeps the operator's line verbatim,
    // through `unexpressibleLines` — the same mechanism that held it before
    // this namespace had a codec at all.
    await writeConfig(storage, { ...cfg, personality: 'engineer' }, new InMemorySecretsResolver());
    expect(await storage.read(path)).toContain('modelRegistry.sonnet.maxTokens: 4096');
  });

  it('ignores a non-numeric contextWindow', async () => {
    const cfg = await load([...base, 'modelRegistry.sonnet.contextWindow: lots'].join('\n'));
    expect(cfg?.modelRegistry?.entries.sonnet?.contextWindow).toBeUndefined();
  });

  // The codec judges nothing: `validateModelRegistry` (T1.3) owes the operator a
  // refusal that names the alias, and it cannot name an entry that was thrown
  // away on the way in.
  it('keeps a half-typed entry so the validator can refuse it by name', async () => {
    const cfg = await load([...base, 'modelRegistry.sonnet.provider: anthropic-work'].join('\n'));
    expect(cfg?.modelRegistry?.entries.sonnet).toEqual({
      alias: 'sonnet',
      provider: 'anthropic-work',
      modelId: '',
    });
  });

  it('never makes a reserved alias an own key, and says which line it ignored', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      path,
      `${[
        'schemaVersion: 1',
        'provider: anthropic',
        'model: claude-opus-4-7',
        'personality: p',
        'modelRegistry.__proto__.provider: polluted',
      ].join('\n')}\n`,
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.modelRegistry).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The notice reaches the same boot channel `parseProviderChain`'s do.
    const loaded = await loadConfigStrict(storage, new InMemorySecretsResolver());
    expect(loaded?.deprecations.join('\n')).toContain('modelRegistry.__proto__.provider');
  });

  it('leaves modelRegistry undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.modelRegistry).toBeUndefined();
  });

  // `modelRegistry.` is not `models.` — the §7 per-model profile prefix is a
  // literal seven characters and cannot claim a registry line.
  it('does not collide with the §7 models.<providerId>/<modelId> namespace', async () => {
    const cfg = await load(
      [
        ...base,
        'modelRegistry.sonnet.provider: anthropic-work',
        'modelRegistry.sonnet.modelId: claude-sonnet-5',
        'models.ollama/llama3.2.sampling.temperature: 0.2',
      ].join('\n'),
    );
    expect(cfg?.modelRegistry?.entries.sonnet?.modelId).toBe('claude-sonnet-5');
    expect(cfg?.models?.['ollama/llama3.2']?.sampling?.temperature).toBe(0.2);
  });
});

describe('modelRegistry serialization', () => {
  const REGISTRY_YAML = [
    'modelRegistry.sonnet.provider: anthropic-work',
    'modelRegistry.sonnet.modelId: claude-sonnet-5',
    'modelRegistry.sonnet.label: everyday driver',
    'modelRegistry.sonnet.contextWindow: 200000',
    'modelRegistry.sonnet.costPer1kInput: 0.003',
    'modelRegistry.sonnet.costPer1kOutput: 0.015',
    'modelRegistry.sonnet.fallbacks: sonnet-eu,sonnet-old',
    'modelRegistry.qwen.provider: local',
    'modelRegistry.qwen.modelId: qwen2.5-coder:32b',
    'modelRegistry.qwen.contextWindow: 131072',
    'modelRegistry.default: sonnet',
    'modelRegistry.roles.trivial: haiku',
    'modelRegistry.roles.deep: opus',
  ];

  it('round-trips a registry through parse→serialize byte-identically', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(path, `${[...base, ...REGISTRY_YAML].join('\n')}\n`);

    const first = await readRawConfig(storage);
    if (!first) throw new Error('config did not parse');
    await writeConfig(storage, first, secrets);
    const written = await storage.read(path);
    for (const line of REGISTRY_YAML) expect(written).toContain(`${line}\n`);

    // The registry block, in the serializer's order, is exactly what went in.
    const registryLines = (written ?? '').split('\n').filter((l) => l.startsWith('modelRegistry.'));
    expect(registryLines).toEqual(REGISTRY_YAML);
  });

  // The write→read→write shape from config-scalar-roundtrip.test.ts: a second
  // write over the first must not move, requote or drop a byte.
  it('is byte-identical across a write → read → write cycle', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(path, `${[...base, ...REGISTRY_YAML].join('\n')}\n`);

    const first = await readRawConfig(storage);
    if (!first) throw new Error('config did not parse');
    await writeConfig(storage, first, secrets);
    const once = await storage.read(path);

    const second = await readRawConfig(storage);
    if (!second) throw new Error('rewritten config did not parse');
    expect(second.modelRegistry).toEqual(first.modelRegistry);
    await writeConfig(storage, second, secrets);
    expect(await storage.read(path)).toBe(once);
  });

  it('deletes the whole block when the registry is cleared', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(path, `${[...base, ...REGISTRY_YAML].join('\n')}\n`);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, { ...cfg, modelRegistry: undefined }, secrets);
    expect(await storage.read(path)).not.toContain('modelRegistry.');
  });

  it('omits empty values, so a half-typed entry survives a rewrite unchanged', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(path, `${[...base, 'modelRegistry.sonnet.label: wip'].join('\n')}\n`);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, cfg, secrets);
    const written = await storage.read(path);
    expect(written).toContain('modelRegistry.sonnet.label: wip');
    expect(written).not.toContain('modelRegistry.sonnet.provider');
    expect(written).not.toContain('modelRegistry.sonnet.modelId');
  });

  it('preserves every registry entry across an unrelated save', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(path, `${[...base, ...REGISTRY_YAML].join('\n')}\n`);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, { ...cfg, personality: 'engineer' }, secrets);
    const after = await readRawConfig(storage);
    expect(after?.personality).toBe('engineer');
    expect(after?.modelRegistry).toEqual(cfg.modelRegistry);
  });
});

describe('providers.<n>.id and providers.<n>.failover', () => {
  it('providers.<n>.id round-trips and is optional', () => {
    const entries = [
      { provider: 'anthropic', id: 'anthropic-work', apiKey: 'ref-a' },
      { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    ];
    expect(renderProviderChain(entries)).toEqual([
      ['providers.0.provider', 'anthropic'],
      ['providers.0.id', 'anthropic-work'],
      ['providers.0.apiKey', 'ref-a'],
      ['providers.1.provider', 'ollama'],
      ['providers.1.baseUrl', 'http://127.0.0.1:11434/v1'],
    ]);
    const lines = renderProviderChain(entries).map(([k, v]) => `${k}: ${v}`);
    expect(parseProviderChain(lines)).toEqual(entries);
  });

  it('a failover:false entry round-trips and defaults to true when absent', () => {
    const entries = [
      { provider: 'anthropic', id: 'anthropic-work' },
      { provider: 'openai', id: 'openai-vision', failover: false },
      { provider: 'ollama', id: 'local', failover: true },
    ];
    const lines = renderProviderChain(entries).map(([k, v]) => `${k}: ${v}`);
    expect(lines).toContain('providers.1.failover: false');
    // An explicit `true` is kept, because the default is absence, not `false`.
    expect(lines).toContain('providers.2.failover: true');
    expect(lines).not.toContain('providers.0.failover: true');

    const parsed = parseProviderChain(lines);
    expect(parsed).toEqual(entries);
    // Absent means "is a failover hop" — the state every entry that ever
    // existed was in.
    expect(parsed[0]?.failover).toBeUndefined();
    expect(parsed[1]?.failover).toBe(false);
  });

  it('ignores an unreadable failover value and says so', () => {
    const notices: string[] = [];
    const entries = parseProviderChain(
      ['providers.0.provider: anthropic', 'providers.0.failover: maybe'],
      notices,
    );
    expect(entries).toEqual([{ provider: 'anthropic' }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('providers.0.failover');
  });

  it('a provider entry that carried id/failover as passthrough promotes to modelled without duplicate lines', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    // A config written before this codec modelled the two fields: they were
    // unknown, so they sat in `passthrough` and rendered in the sorted tail.
    await storage.write(
      path,
      `${[
        'schemaVersion: 1',
        ...base,
        'providers.0.provider: anthropic',
        'providers.0.id: anthropic-work',
        'providers.0.failover: false',
        'providers.0.fooBar: keep-me',
      ].join('\n')}\n`,
    );

    const cfg = await readRawConfig(storage);
    expect(cfg?.providers?.[0]).toEqual({
      provider: 'anthropic',
      id: 'anthropic-work',
      apiKey: '',
      failover: false,
      passthrough: { fooBar: 'keep-me' },
    });
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, cfg, secrets);
    const chainLines = ((await storage.read(path)) ?? '')
      .split('\n')
      .filter((l) => l.startsWith('providers.'));
    expect(chainLines).toEqual([
      'providers.0.provider: anthropic',
      'providers.0.id: anthropic-work',
      'providers.0.failover: false',
      'providers.0.fooBar: keep-me',
    ]);
  });

  it('carries id and failover through an unrelated save, and moves them with the entry', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      path,
      `${[
        'schemaVersion: 1',
        ...base,
        'providers.0.provider: anthropic',
        'providers.0.id: anthropic-work',
        'providers.1.provider: openai',
        'providers.1.id: openai-vision',
        'providers.1.failover: false',
      ].join('\n')}\n`,
    );
    const cfg = await readRawConfig(storage);
    const [anthropic, openai] = cfg?.providers ?? [];
    if (!cfg || !anthropic || !openai) throw new Error('fixture chain missing');

    await writeConfig(storage, { ...cfg, providers: [openai, anthropic] }, secrets);
    const after = await readRawConfig(storage);
    expect(after?.providers?.[0]).toMatchObject({ id: 'openai-vision', failover: false });
    expect(after?.providers?.[1]).toMatchObject({ id: 'anthropic-work' });
    expect(after?.providers?.[1]?.failover).toBeUndefined();
  });

  // Neither field names a credential, so `secretRefForConfigKey` maps neither
  // to a vault ref — and both are modelled, so `externalizeProviderChain`
  // (which walks `apiKey` and `passthrough` only) never sees them.
  it('leaves id and failover as plaintext, since neither is credential-bearing', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        schemaVersion: 1,
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: '',
        personality: 'researcher',
        providers: [{ provider: 'anthropic', apiKey: '', id: 'anthropic-work', failover: false }],
      },
      secrets,
    );
    const src = await storage.read(path);
    expect(src).toContain('providers.0.id: anthropic-work');
    expect(src).toContain('providers.0.failover: false');
    expect(src).not.toContain('secrets:providers/0/id');
  });
});

describe('deriveProviderKey', () => {
  it('returns an explicit id whatever the index', () => {
    expect(deriveProviderKey({ provider: 'anthropic', id: 'anthropic-work' }, 0)).toBe(
      'anthropic-work',
    );
    expect(deriveProviderKey({ provider: 'anthropic', id: 'anthropic-work' }, 3)).toBe(
      'anthropic-work',
    );
  });

  // The derived half is POSITIONAL and is a display name only (D24): it renames
  // on a chain reorder, which is why a registry alias may reference only an
  // entry carrying an explicit `id:`.
  it('derives a positional name from the index when no id is set', () => {
    expect(deriveProviderKey({ provider: 'anthropic' }, 0)).toBe('anthropic');
    expect(deriveProviderKey({ provider: 'anthropic' }, 1)).toBe('anthropic-1');
    expect(deriveProviderKey({ provider: 'ollama' }, 2)).toBe('ollama-2');
  });

  it('renames a derived key on reorder and keeps an explicit one', () => {
    const chain = [{ provider: 'anthropic' }, { provider: 'ollama', id: 'local' }];
    expect(chain.map((e, i) => deriveProviderKey(e, i))).toEqual(['anthropic', 'local']);
    const reordered = [...chain].reverse();
    expect(reordered.map((e, i) => deriveProviderKey(e, i))).toEqual(['local', 'anthropic-1']);
  });
});
