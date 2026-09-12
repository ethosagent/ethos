// F01 follow-up (plan/phases/architecture-suggestions-2026-09-10.md): the
// Settings page sends the WHOLE provider chain on every save, built from rows
// that carry only provider / model / baseUrl (and a key only when retyped).
// `ConfigService.update` overlays each row onto the stored entry it came from
// (`sourceIndex`), so a save keeps the key reference, the provider-specific
// fields and the unmodelled `passthrough` the CLI wrote.

import { join } from 'node:path';
import {
  ethosDir,
  loadConfigStrict,
  readConfig,
  readRawConfig,
  writeConfig,
} from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { statusFor } from '../../middleware/error-envelope';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService, type ConfigUpdateInput } from '../../services/config.service';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

type ChainPatch = NonNullable<ConfigUpdateInput['providers']>;

describe('ConfigService.update — provider chain from the Settings page', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
  const path = join(ethosDir(), 'config.yaml');

  /**
   * What the Settings page sends for an untouched chain: `rowsFromConfig`
   * (apps/web/src/pages/settings/lib/rows.ts) over `config.get`'s `providers`,
   * then `buildConfigPatch`'s row → entry mapping. web-api cannot import
   * apps/web, so the mapping is restated here; apps/web's
   * `settings-provider-rows.test.ts` and `settings-patch-completeness.test.ts`
   * pin the other half.
   */
  // The `providersVersion` of the `config.get` the rows were built from — the
  // page sends it back so a save against a changed chain is refused.
  let loadedVersion = '';

  async function settingsRows(): Promise<ChainPatch> {
    const { providers, providersVersion } = await service.get();
    loadedVersion = providersVersion;
    return providers.map((p, i) => ({
      provider: p.provider,
      sourceIndex: i,
      ...(p.model ? { model: p.model } : {}),
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    }));
  }

  function save(patch: ConfigUpdateInput): Promise<void> {
    return service.update({ providersVersion: loadedVersion, ...patch });
  }

  async function chain() {
    return (await readRawConfig(storage))?.providers ?? [];
  }

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    const repo = new ConfigRepository({ dataDir: ethosDir(), storage, secrets });
    service = new ConfigService({ config: repo, secrets });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: '',
        personality: 'researcher',
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-chain-0123456789abcdef' },
          {
            provider: 'bedrock',
            apiKey: 'bedrock-key-0123456789abcdef',
            model: 'anthropic.claude-v2',
            region: 'eu-west-1',
            awsProfile: 'sso-prod',
          },
          {
            provider: 'azure',
            apiKey: 'azure-key-0123456789abcdef',
            baseUrl: 'https://example.openai.azure.com',
            apiVersion: '2024-10-21',
          },
        ],
      },
      secrets,
    );
    // Unmodelled, and owned by entry 1 (bedrock).
    await storage.write(path, `${await storage.read(path)}providers.1.fooBar: keep-me\n`);
  });

  it('an unrelated save keeps every stored provider field', async () => {
    await save({ verbosity: 'verbose', providers: await settingsRows() });

    expect(await chain()).toEqual([
      { provider: 'anthropic', apiKey: secretRef('providers/0/anthropic/apiKey') },
      {
        provider: 'bedrock',
        apiKey: secretRef('providers/1/bedrock/apiKey'),
        model: 'anthropic.claude-v2',
        region: 'eu-west-1',
        awsProfile: 'sso-prod',
        passthrough: { fooBar: 'keep-me' },
      },
      {
        provider: 'azure',
        apiKey: secretRef('providers/2/azure/apiKey'),
        baseUrl: 'https://example.openai.azure.com',
        apiVersion: '2024-10-21',
      },
    ]);
    const yaml = await storage.read(path);
    expect(yaml).toContain('verbosity: verbose');
    expect(yaml).not.toContain('0123456789abcdef');
  });

  it('editing a row changes only what the row shows', async () => {
    const rows = await settingsRows();
    const [anthropic, bedrock, azure] = rows;
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    await save({
      providers: [
        anthropic,
        { ...bedrock, model: 'anthropic.claude-v3' },
        // A cleared field is ABSENT from the row — the page sends its full state.
        { provider: azure.provider, sourceIndex: azure.sourceIndex },
      ],
    });

    const [, b, a] = await chain();
    expect(b).toEqual({
      provider: 'bedrock',
      apiKey: secretRef('providers/1/bedrock/apiKey'),
      model: 'anthropic.claude-v3',
      region: 'eu-west-1',
      awsProfile: 'sso-prod',
      passthrough: { fooBar: 'keep-me' },
    });
    expect(a).toEqual({
      provider: 'azure',
      apiKey: secretRef('providers/2/azure/apiKey'),
      apiVersion: '2024-10-21',
    });
  });

  it('a retyped key replaces only that entry key, and never lands in the file', async () => {
    const rows = await settingsRows();
    await save({
      providers: rows.map((r) =>
        r.provider === 'bedrock' ? { ...r, apiKey: 'bedrock-new-key-9876543210' } : r,
      ),
    });

    const [, b] = await chain();
    expect(b).toMatchObject({ region: 'eu-west-1', passthrough: { fooBar: 'keep-me' } });
    expect(b?.apiKey).toBe(secretRef('providers/1/bedrock/apiKey'));
    expect(await secrets.get('providers/1/bedrock/apiKey')).toBe('bedrock-new-key-9876543210');
    expect(await storage.read(path)).not.toContain('9876543210');
  });

  it('a reorder moves every field with its entry', async () => {
    const [anthropic, bedrock, azure] = await settingsRows();
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    await save({ providers: [bedrock, azure, anthropic] });

    const after = await chain();
    expect(after.map((p) => p.provider)).toEqual(['bedrock', 'azure', 'anthropic']);
    expect(after[0]).toMatchObject({
      apiKey: secretRef('providers/1/bedrock/apiKey'),
      region: 'eu-west-1',
      awsProfile: 'sso-prod',
      passthrough: { fooBar: 'keep-me' },
    });
    expect(after[1]).toMatchObject({
      apiKey: secretRef('providers/2/azure/apiKey'),
      apiVersion: '2024-10-21',
    });
    expect(after[2]?.apiKey).toBe(secretRef('providers/0/anthropic/apiKey'));
    expect(after[1]?.passthrough).toBeUndefined();
    expect(await storage.read(path)).toContain('providers.0.fooBar: keep-me');
  });

  it('a deleted row takes its fields with it', async () => {
    const rows = await settingsRows();
    await save({ providers: rows.filter((r) => r.provider !== 'bedrock') });

    const after = await chain();
    expect(after.map((p) => p.provider)).toEqual(['anthropic', 'azure']);
    expect(after[1]).toMatchObject({
      apiKey: secretRef('providers/2/azure/apiKey'),
      apiVersion: '2024-10-21',
    });
    const yaml = await storage.read(path);
    expect(yaml).not.toContain('fooBar');
    expect(yaml).not.toContain('eu-west-1');
    expect(yaml).not.toContain('providers/1/bedrock/apiKey');
  });

  it('changing a row provider starts a fresh entry — no key or fields cross over', async () => {
    const rows = await settingsRows();
    await save({
      providers: rows.map((r) =>
        r.provider === 'bedrock' ? { provider: 'openrouter', sourceIndex: r.sourceIndex } : r,
      ),
    });

    const [, changed] = await chain();
    expect(changed).toEqual({ provider: 'openrouter', apiKey: '' });
  });

  it('a new row, or one whose sourceIndex is stale, is a fresh entry', async () => {
    const rows = await settingsRows();
    await save({
      providers: [
        ...rows,
        { provider: 'ollama', model: 'llama3' },
        { provider: 'bedrock', sourceIndex: 99 },
      ],
    });

    const after = await chain();
    expect(after[3]).toEqual({ provider: 'ollama', apiKey: '', model: 'llama3' });
    expect(after[4]).toEqual({ provider: 'bedrock', apiKey: '' });
  });

  // Vault names embed the index an entry had when its key was first stored
  // (`providers/1/bedrock/apiKey`), and an entry keeps its name when it moves.
  it('a key typed at a vacated index does not overwrite a moved entry secret', async () => {
    const [anthropic, bedrock, azure] = await settingsRows();
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    // bedrock moves to 0; a NEW bedrock row lands at 1, the index the moved
    // entry's secret is named after.
    await save({
      providers: [
        bedrock,
        { provider: 'bedrock', apiKey: 'bedrock-second-account-key' },
        azure,
        anthropic,
      ],
    });

    const resolved = (await readConfig(storage, secrets))?.providers ?? [];
    expect(resolved.map((p) => p.apiKey)).toEqual([
      'bedrock-key-0123456789abcdef',
      'bedrock-second-account-key',
      'azure-key-0123456789abcdef',
      'sk-ant-chain-0123456789abcdef',
    ]);
  });

  it('removes a deleted row secret from the vault', async () => {
    const rows = await settingsRows();
    await save({ providers: rows.filter((r) => r.provider !== 'bedrock') });

    expect(await secrets.get('providers/1/bedrock/apiKey')).toBeNull();
    expect(await secrets.get('providers/0/anthropic/apiKey')).toBe('sk-ant-chain-0123456789abcdef');
    expect(await secrets.get('providers/2/azure/apiKey')).toBe('azure-key-0123456789abcdef');
  });

  it('removes a replaced key secret when the entry is stored under a new name', async () => {
    const [anthropic, bedrock, azure] = await settingsRows();
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    await save({
      providers: [{ ...bedrock, apiKey: 'bedrock-rotated-key' }, anthropic, azure],
    });

    const [moved] = await chain();
    expect(moved?.apiKey).toBe(secretRef('providers/0/bedrock/apiKey'));
    expect(await secrets.get('providers/0/bedrock/apiKey')).toBe('bedrock-rotated-key');
    expect(await secrets.get('providers/1/bedrock/apiKey')).toBeNull();
    expect(moved).toMatchObject({ region: 'eu-west-1', passthrough: { fooBar: 'keep-me' } });
  });

  it('keeps a deleted row secret that another config line still references', async () => {
    // The top-level key points at the same vault entry as chain entry 0.
    await storage.write(
      path,
      `${await storage.read(path)}apiKey: ${secretRef('providers/0/anthropic/apiKey')}\n`,
    );
    const rows = await settingsRows();
    await save({ providers: rows.filter((r) => r.provider !== 'anthropic') });

    expect(await secrets.get('providers/0/anthropic/apiKey')).toBe('sk-ant-chain-0123456789abcdef');
  });

  it('refuses two rows that claim the same stored entry', async () => {
    const [anthropic] = await settingsRows();
    if (!anthropic) throw new Error('fixture chain missing');
    const before = await storage.read(path);
    await expect(save({ providers: [anthropic, { ...anthropic }] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await storage.read(path)).toBe(before);
  });

  it('refuses a providers list that does not say which chain it was built from', async () => {
    const rows = await settingsRows();
    await expect(service.update({ providers: rows })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  // Two same-looking entries swapped: without a version in the response the
  // refetch is deep-equal, React Query keeps the old object, and the page's
  // rows keep sourceIndex values that now point at the other entry.
  it('config.get changes when two same-looking entries swap', async () => {
    await storage.write(
      path,
      [
        'provider: anthropic',
        'model: m',
        'providers.0.provider: openai',
        `providers.0.apiKey: ${secretRef('providers/0/openai/apiKey')}`,
        'providers.1.provider: openai',
        `providers.1.apiKey: ${secretRef('providers/1/openai/apiKey')}`,
        '',
      ].join('\n'),
    );
    const [first, second] = await settingsRows();
    if (!first || !second) throw new Error('fixture chain missing');
    const before = await service.get();
    await save({ providers: [second, first] });
    const after = await service.get();
    expect(after.providers).toEqual(before.providers);
    expect(after.providersVersion).not.toBe(before.providersVersion);
  });

  it('reads back what it writes, without growing escapes, for every kind of field', async () => {
    const tricky = 'C:\\tmp\\\\srv "x" #1: a ';
    await storage.write(
      path,
      [
        'provider: anthropic',
        'model: m',
        `baseUrl: ${JSON.stringify(` ${tricky}`)}`,
        'providers.0.provider: openai',
        `providers.0.note: ${JSON.stringify(tricky)}`,
        `telegram.bots.0.bind.name: ${JSON.stringify(tricky)}`,
        '',
      ].join('\n'),
    );
    for (let i = 0; i < 3; i++) {
      const rows = await settingsRows();
      await save({ verbosity: i % 2 ? 'concise' : 'verbose', providers: rows });
    }
    const raw = await readRawConfig(storage);
    expect(raw?.baseUrl).toBe(` ${tricky}`);
    expect(raw?.providers?.[0]?.passthrough?.note).toBe(tricky);
    const web = await service.get();
    expect(web.baseUrl).toBe(` ${tricky}`);
  });
});

// A page loaded before someone else changed the chain must not overlay its
// rows onto whatever sits at those indexes now (verify-f01/stale.mts).
describe('ConfigService.update — a stale provider chain', () => {
  it('refuses with CONFIG_CONFLICT and writes nothing — file and vault intact', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: '',
        personality: 'researcher',
        providers: [
          { provider: 'openai', apiKey: 'sk-A-openai', model: 'gpt-4o' },
          { provider: 'anthropic', apiKey: 'sk-B-anthropic', model: 'claude' },
        ],
      },
      secrets,
    );
    // The Settings page loads.
    const loaded = await service.get();
    const rows = loaded.providers.map((p, i) => ({
      provider: p.provider,
      ...(p.model ? { model: p.model } : {}),
      sourceIndex: i,
    }));
    // Meanwhile `ethos fallback remove 1` drops openai: config first, then vault.
    const raw = await readRawConfig(storage);
    if (!raw) throw new Error('config did not parse');
    await writeConfig(storage, { ...raw, providers: raw.providers?.slice(1) }, secrets);
    await secrets.delete('providers/0/openai/apiKey');
    const file = await storage.read(join(ethosDir(), 'config.yaml'));
    const vault = await secrets.list();

    // The stale page saves an unrelated change with its full rows.
    await expect(
      service.update({
        verbosity: 'verbose',
        providers: rows,
        providersVersion: loaded.providersVersion,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });

    expect(statusFor('CONFIG_CONFLICT')).toBe(409);
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toBe(file);
    expect(await secrets.list()).toEqual(vault);
    expect(await secrets.get('providers/1/anthropic/apiKey')).toBe('sk-B-anthropic');
  });
});

// A save must never pair the top-level `provider` with another provider's
// key (verify-f01/smoke-full.mts). The runtime reads the top-level fields when
// the chain has fewer than two entries (`createLLM`, packages/wiring).
describe('ConfigService.update — top-level provider and key stay a pair', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        apiKey: 'sk-ant-top-0123456789',
        personality: 'researcher',
        providers: [
          { provider: 'openai', apiKey: 'sk-openai-0123456789', model: 'gpt-4o' },
          { provider: 'ollama', apiKey: '', model: 'llama3' },
        ],
      },
      secrets,
    );
  });

  async function rows() {
    const got = await service.get();
    return {
      providersVersion: got.providersVersion,
      providers: got.providers.map((p, i) => ({
        provider: p.provider,
        ...(p.model ? { model: p.model } : {}),
        sourceIndex: i,
      })),
    };
  }

  it('moving the top-level provider to chain row 0 carries that entry key with it', async () => {
    await service.update({ ...(await rows()), provider: 'openai', model: 'gpt-4o' });
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.provider).toBe('openai');
    expect(resolved?.apiKey).toBe('sk-openai-0123456789');
  });

  it('a provider with no stored key gets none — never the previous provider key', async () => {
    const r = await rows();
    const [openai, ollama] = r.providers;
    if (!openai || !ollama) throw new Error('fixture chain missing');
    await service.update({
      providersVersion: r.providersVersion,
      providers: [ollama, openai],
      provider: 'ollama',
      model: 'llama3',
    });
    const raw = await readRawConfig(storage);
    expect(raw?.provider).toBe('ollama');
    expect(raw?.apiKey ?? '').toBe('');
  });

  it('an explicitly typed key still wins', async () => {
    await service.update({ provider: 'mistral', apiKey: 'mistral-key-0123456789' });
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.provider).toBe('mistral');
    expect(resolved?.apiKey).toBe('mistral-key-0123456789');
  });

  it('a save that leaves the provider alone leaves the key alone', async () => {
    await service.update({ ...(await rows()), verbosity: 'verbose' });
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.provider).toBe('anthropic');
    expect(resolved?.apiKey).toBe('sk-ant-top-0123456789');
  });
});

// Chain secrets can be named from files other than config.yaml — an MCP
// server's env in `mcp.json`, a personality's `mcp.yaml`. Deleting one because
// config.yaml stopped naming it would break the other user.
describe('ConfigService — orphaned chain secrets referenced elsewhere', () => {
  it('keeps a deleted row secret that a personality file still references', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: '',
        personality: 'researcher',
        providers: [
          { provider: 'openai', apiKey: 'sk-openai-0123456789' },
          { provider: 'groq', apiKey: 'gsk-groq-0123456789' },
        ],
      },
      secrets,
    );
    await storage.mkdir(join(ethosDir(), 'personalities', 'scout'));
    await storage.write(
      join(ethosDir(), 'personalities', 'scout', 'mcp.yaml'),
      `servers:\n  - name: x\n    env:\n      KEY: ${secretRef('providers/1/groq/apiKey')}\n`,
    );
    await storage.write(
      join(ethosDir(), 'mcp.json'),
      JSON.stringify({ servers: { y: { env: { K: secretRef('providers/0/openai/apiKey') } } } }),
    );
    const got = await service.get();
    await service.update({ providers: [], providersVersion: got.providersVersion });

    expect(await secrets.get('providers/1/groq/apiKey')).toBe('gsk-groq-0123456789');
    expect(await secrets.get('providers/0/openai/apiKey')).toBe('sk-openai-0123456789');
  });
});

// A config with only top-level provider fields — what `ethos setup` writes —
// shows ONE row on the Settings page, built from those fields (no
// `sourceIndex`). The runtime reads the top-level fields while the chain has
// fewer than two entries and the chain from two on (`createLLM`).
describe('ConfigService.update — a legacy top-level config meets the chain editor', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
  const path = join(ethosDir(), 'config.yaml');

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'azure',
        model: 'gpt-4o',
        apiKey: 'azure-top-0123456789',
        baseUrl: 'https://example.openai.azure.com',
        apiVersion: '2024-10-21',
        personality: 'researcher',
      },
      secrets,
    );
  });

  /** The single row `rowsFromConfig` builds from the top-level fields. */
  const legacyRow = {
    provider: 'azure',
    model: 'gpt-4o',
    baseUrl: 'https://example.openai.azure.com',
  };

  it('a save with just the legacy row writes no one-entry chain', async () => {
    const { providersVersion } = await service.get();
    await service.update({ verbosity: 'verbose', providers: [legacyRow], providersVersion });

    expect(await storage.read(path)).not.toMatch(/^providers\./m);
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.providers).toBeUndefined();
    expect(resolved?.apiKey).toBe('azure-top-0123456789');
  });

  it('adding a second row makes entry 0 the top-level provider, key and all', async () => {
    const { providersVersion } = await service.get();
    await service.update({
      providers: [legacyRow, { provider: 'openrouter', apiKey: 'sk-or-new-0123456789' }],
      providersVersion,
    });

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.providers?.[0]).toMatchObject({
      provider: 'azure',
      apiKey: 'azure-top-0123456789',
      model: 'gpt-4o',
      baseUrl: 'https://example.openai.azure.com',
      apiVersion: '2024-10-21',
    });
    expect(resolved?.providers?.[1]?.apiKey).toBe('sk-or-new-0123456789');
    // Entry 0 names the SAME vault entry as the top-level key.
    const raw = await readRawConfig(storage);
    expect(raw?.providers?.[0]?.apiKey).toBe(raw?.apiKey);
  });

  // The Settings page before this fix wrote a keyless `providers.0` on every
  // save of a legacy config; the next second row made it the keyless primary.
  it('repairs the keyless entry 0 an earlier save left behind', async () => {
    await storage.write(
      path,
      `${await storage.read(path)}providers.0.provider: azure\nproviders.0.model: gpt-4o\n`,
    );
    const got = await service.get();
    await service.update({
      providers: [
        { provider: 'azure', model: 'gpt-4o', sourceIndex: 0 },
        { provider: 'openrouter', apiKey: 'sk-or-new-0123456789' },
      ],
      providersVersion: got.providersVersion,
    });

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.providers?.[0]?.apiKey).toBe('azure-top-0123456789');
  });

  it('a new first row of a different provider does not inherit the top-level key', async () => {
    const { providersVersion } = await service.get();
    await service.update({
      providers: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'ollama', model: 'llama3' },
      ],
      providersVersion,
    });
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.providers?.[0]?.apiKey).toBe('');
  });
});

// A save that drops the top-level key reference — a provider switch with no
// key to carry — must not leave the vault entry behind (the same sweep, and
// the same whole-data-dir reference scan, chain secrets get).
// Only the chain writers' own index-named secrets (`providers/<n>/…`) are ever
// swept. A canonical by-name secret — `providers/openai/apiKey` — is read
// DIRECTLY by name by llm-openai-compat, llm-anthropic, llm-azure, tools-image
// and engine_ask, with no `${secrets:…}` line anywhere; config.yaml not naming
// it says nothing about whether it is in use.
describe('ConfigService.update — which removed secrets are swept', () => {
  async function setup(chain?: Array<{ provider: string; apiKey: string; model?: string }>) {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-openai-top-0123456789',
        personality: 'p',
        ...(chain ? { providers: chain } : {}),
      },
      secrets,
    );
    return { storage, secrets, service };
  }

  it('keeps a canonical by-name key when the primary provider switches', async () => {
    const { secrets, service } = await setup();
    await service.update({ provider: 'anthropic', model: 'claude', apiKey: 'sk-ant-0123456789' });
    // What llm-openai-compat / tools-image / engine_ask resolve, by name.
    expect(await secrets.get('providers/openai/apiKey')).toBe('sk-openai-top-0123456789');
  });

  it('keeps it when the chain entry that named it is deleted and the primary moves', async () => {
    const { secrets, service } = await setup([
      { provider: 'openai', apiKey: secretRef('providers/openai/apiKey') },
      { provider: 'anthropic', apiKey: 'sk-ant-chain-0123456789', model: 'claude' },
    ]);
    const got = await service.get();
    await service.update({
      providersVersion: got.providersVersion,
      provider: 'anthropic',
      model: 'claude',
      providers: [{ provider: 'anthropic', model: 'claude', sourceIndex: 1 }],
    });
    expect(await secrets.get('providers/openai/apiKey')).toBe('sk-openai-top-0123456789');
  });

  it('sweeps an index-named top-level key the save dropped', async () => {
    const { storage, secrets, service } = await setup([
      { provider: 'openai', apiKey: 'sk-openai-chain-0123456789' },
      { provider: 'anthropic', apiKey: 'sk-ant-chain-0123456789', model: 'claude' },
    ]);
    // The top-level key names chain entry 0's secret (what a provider move writes).
    const text = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      text.replace(/^apiKey: .*$/m, `apiKey: ${secretRef('providers/0/openai/apiKey')}`),
    );
    const got = await service.get();
    await service.update({
      providersVersion: got.providersVersion,
      provider: 'ollama',
      model: 'llama3',
      providers: [
        { provider: 'ollama', model: 'llama3' },
        { provider: 'anthropic', model: 'claude', sourceIndex: 1 },
      ],
    });
    expect(await secrets.get('providers/0/openai/apiKey')).toBeNull();
    expect(await secrets.get('providers/openai/apiKey')).toBe('sk-openai-top-0123456789');
  });
});

// Shrinking the chain below two entries hands the runtime back to the
// top-level fields (`createLLM`). The entry that becomes the top level must
// bring everything the runtime reads for it, and the old provider's
// provider-specific fields must go.
describe('ConfigService.update — the top level mirrors the entry it moves to', () => {
  it('a bedrock entry keeps its region and profile when the chain shrinks to it', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-ant-0123456789',
        personality: 'p',
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-0123456789', model: 'claude-opus-4-7' },
          {
            provider: 'bedrock',
            apiKey: 'bedrock-0123456789',
            model: 'anthropic.claude-v2',
            region: 'eu-west-1',
            awsProfile: 'sso-prod',
          },
        ],
      },
      secrets,
    );
    const got = await service.get();
    // Row 0 deleted: the page sends the new primary's provider and model.
    await service.update({
      providersVersion: got.providersVersion,
      provider: 'bedrock',
      model: 'anthropic.claude-v2',
      baseUrl: '',
      providers: [{ provider: 'bedrock', model: 'anthropic.claude-v2', sourceIndex: 1 }],
    });

    const rt = (await loadConfigStrict(storage, secrets))?.config;
    expect(rt).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-v2',
      apiKey: 'bedrock-0123456789',
      region: 'eu-west-1',
      awsProfile: 'sso-prod',
    });
  });

  // The Settings page always sends `provider` and `model` together; a direct
  // RPC caller need not, and a model belongs to the provider it was picked for.
  it('clears a stale model when a patch moves the provider without one', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-openai-0123456789',
        personality: 'p',
      },
      secrets,
    );

    await service.update({ provider: 'bedrock' });

    const rt = (await loadConfigStrict(storage, secrets))?.config;
    expect(rt?.provider).toBe('bedrock');
    // The line is gone, so the parser's built-in default applies — never the
    // model that was picked for the provider this patch moved away from.
    expect(rt?.model).not.toBe('gpt-4o');
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).not.toContain('gpt-4o');
    expect(rt?.apiKey ?? '').toBe('');
  });

  it('drops the old provider-specific fields when the new entry has none', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const service = new ConfigService({
      config: new ConfigRepository({ dataDir: ethosDir(), storage, secrets }),
      secrets,
    });
    await writeConfig(
      storage,
      {
        provider: 'azure',
        model: 'gpt-4o',
        apiKey: 'azure-0123456789',
        baseUrl: 'https://example.openai.azure.com',
        apiVersion: '2024-10-21',
        personality: 'p',
        providers: [
          { provider: 'azure', apiKey: 'azure-0123456789', apiVersion: '2024-10-21' },
          { provider: 'openai', apiKey: 'sk-openai-0123456789', model: 'gpt-4o' },
        ],
      },
      secrets,
    );
    const got = await service.get();
    await service.update({
      providersVersion: got.providersVersion,
      provider: 'openai',
      model: 'gpt-4o',
      providers: [{ provider: 'openai', model: 'gpt-4o', sourceIndex: 1 }],
    });

    const rt = (await loadConfigStrict(storage, secrets))?.config;
    expect(rt?.provider).toBe('openai');
    expect(rt?.apiKey).toBe('sk-openai-0123456789');
    expect(rt?.apiVersion).toBeUndefined();
    expect(rt?.baseUrl).toBeUndefined();
  });
});

describe('ConfigService.rotateProviderKey', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
  const path = join(ethosDir(), 'config.yaml');

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    const repo = new ConfigRepository({ dataDir: ethosDir(), storage, secrets });
    service = new ConfigService({ config: repo, secrets });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-ant-top-0123456789abcdef',
        personality: 'researcher',
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-chain-0123456789abcdef' },
          {
            provider: 'bedrock',
            apiKey: 'bedrock-key-0123456789abcdef',
            region: 'eu-west-1',
            awsProfile: 'sso-prod',
          },
          { provider: 'azure', apiKey: 'azure-key-0123456789abcdef', apiVersion: '2024-10-21' },
        ],
      },
      secrets,
    );
    await storage.write(path, `${await storage.read(path)}providers.1.fooBar: keep-me\n`);
  });

  it('rotates a chain entry key and keeps every other field of every entry', async () => {
    const before = (await readRawConfig(storage))?.providers;
    await service.rotateProviderKey('bedrock', 'bedrock-rotated-9876543210');

    const after = (await readRawConfig(storage))?.providers ?? [];
    expect(after).toEqual(before);
    expect(after[1]).toMatchObject({ region: 'eu-west-1', passthrough: { fooBar: 'keep-me' } });
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.apiKey).toBe('sk-ant-top-0123456789abcdef');
    expect(resolved?.providers?.map((p) => p.apiKey)).toEqual([
      'sk-ant-chain-0123456789abcdef',
      'bedrock-rotated-9876543210',
      'azure-key-0123456789abcdef',
    ]);
    expect(await storage.read(path)).not.toContain('9876543210');
  });

  it('rotates the top-level key and every chain entry of that provider', async () => {
    await service.rotateProviderKey('anthropic', 'sk-ant-rotated-9876543210');

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.apiKey).toBe('sk-ant-rotated-9876543210');
    expect(resolved?.providers?.map((p) => p.apiKey)).toEqual([
      'sk-ant-rotated-9876543210',
      'bedrock-key-0123456789abcdef',
      'azure-key-0123456789abcdef',
    ]);
    expect(resolved?.providers?.[1]?.region).toBe('eu-west-1');
    expect(await storage.read(path)).not.toContain('9876543210');
  });

  it('refuses an empty key, which would erase the stored one', async () => {
    const file = await storage.read(path);
    await expect(service.rotateProviderKey('bedrock', '')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await storage.read(path)).toBe(file);
  });

  it('refuses a provider nothing is configured for, and writes nothing', async () => {
    const file = await storage.read(path);
    const vault = await secrets.list();

    await expect(service.rotateProviderKey('mistral', 'sk-new')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await storage.read(path)).toBe(file);
    expect(await secrets.list()).toEqual(vault);
  });
});
