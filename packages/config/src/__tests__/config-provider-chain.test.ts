// The `providers.<n>.*` namespace has one codec (`parseProviderChain` /
// `renderProviderChain`), shared by `writeConfig` here and apps/web-api's
// ConfigRepository (plan/phases/architecture-suggestions-2026-09-10.md F01).
// An unmodelled field belongs to its entry: it moves with the entry on reorder
// and is dropped with it on delete.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  ethosDir,
  isProviderChainLine,
  loadConfigStrict,
  parseProviderChain,
  providerChainVersion,
  readConfig,
  readRawConfig,
  renderProviderChain,
  writeConfig,
} from '../index';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('parseProviderChain', () => {
  it('groups by index, orders numerically, and splits modelled from unknown fields', () => {
    const entries = parseProviderChain([
      'provider: anthropic',
      'providers.10.provider: ollama',
      'providers.2.provider: bedrock',
      'providers.2.region: "eu-west-1"',
      'providers.2.awsProfile: sso-prod',
      'providers.2.fooBar: keep-me',
      'providers.2.nested.knob: 3',
      'providers.0.provider: azure',
      `providers.0.apiKey: ${secretRef('providers/0/azure/apiKey')}`,
      'providers.0.baseUrl: "https://example.openai.azure.com"',
      'providers.0.apiVersion: 2024-10-21',
      'providers.0.model: gpt-4o',
    ]);
    expect(entries).toEqual([
      {
        provider: 'azure',
        apiKey: secretRef('providers/0/azure/apiKey'),
        baseUrl: 'https://example.openai.azure.com',
        apiVersion: '2024-10-21',
        model: 'gpt-4o',
      },
      {
        provider: 'bedrock',
        region: 'eu-west-1',
        awsProfile: 'sso-prod',
        passthrough: { fooBar: 'keep-me', 'nested.knob': '3' },
      },
      { provider: 'ollama' },
    ]);
  });

  it('drops an index with no provider, unknown fields included', () => {
    expect(
      parseProviderChain([
        'providers.0.model: m',
        'providers.0.fooBar: x',
        'providers.1.provider: p',
      ]),
    ).toEqual([{ provider: 'p' }]);
  });

  it('never makes a reserved field an own key', () => {
    const [entry] = parseProviderChain([
      'providers.0.provider: p',
      'providers.0.__proto__: polluted',
      'providers.0.constructor: polluted',
    ]);
    expect(entry).toEqual({ provider: 'p' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // The CLI writer used to keep these verbatim; a codec that claimed the
  // namespace and then dropped them would silently delete operator lines.
  it('keeps odd-but-safe field names, and tolerates space before the colon', () => {
    const [entry] = parseProviderChain([
      'providers.0.provider: p',
      'providers.0.a..b: x',
      'providers.0.trailing.: y',
      'providers.0.model : spaced',
    ]);
    expect(entry).toEqual({
      provider: 'p',
      model: 'spaced',
      passthrough: { 'a..b': 'x', 'trailing.': 'y' },
    });
  });

  it('ignores empty values', () => {
    expect(parseProviderChain(['providers.0.provider: p', 'providers.0.region: ""'])).toEqual([
      { provider: 'p' },
    ]);
  });
});

describe('parseProviderChain notices', () => {
  it('reports an index it dropped for want of a provider line, naming the lines', () => {
    const notices: string[] = [];
    const entries = parseProviderChain(
      [
        'providers.0.provider: openai',
        'providers.1.provder: bedrock',
        'providers.1.region: eu-west-1',
      ],
      notices,
    );
    expect(entries).toEqual([{ provider: 'openai' }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('providers.1.provider');
    expect(notices[0]).toContain('providers.1.provder');
    expect(notices[0]).toContain('providers.1.region');
  });

  it('reports a reserved field name and says nothing about ordinary drops', () => {
    const notices: string[] = [];
    parseProviderChain(
      ['providers.0.provider: openai', 'providers.0.__proto__: x', 'providers.0.apiKey: '],
      notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('providers.0.__proto__');
  });

  it('says nothing when every line lands', () => {
    const notices: string[] = [];
    parseProviderChain(['providers.0.provider: openai', 'providers.0.model: gpt-4o'], notices);
    expect(notices).toEqual([]);
  });

  it('reaches the boot notices, so an operator sees the entry it lost', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: m',
        'personality: p',
        'providers.0.provider: anthropic',
        'providers.1.provder: bedrock',
        'providers.1.region: eu-west-1',
        '',
      ].join('\n'),
    );
    const loaded = await loadConfigStrict(storage, new InMemorySecretsResolver());
    expect(loaded?.deprecations.join('\n')).toContain('providers.1.provider');
  });
});

describe('renderProviderChain', () => {
  it('renders modelled fields in order, then unknown fields sorted, indexed by position', () => {
    expect(
      renderProviderChain([
        { provider: 'anthropic', apiKey: 'ref-a' },
        {
          provider: 'bedrock',
          awsProfile: 'sso',
          region: 'eu-west-1',
          passthrough: { zeta: 'z', alpha: 'a' },
        },
      ]),
    ).toEqual([
      ['providers.0.provider', 'anthropic'],
      ['providers.0.apiKey', 'ref-a'],
      ['providers.1.provider', 'bedrock'],
      ['providers.1.region', 'eu-west-1'],
      ['providers.1.awsProfile', 'sso'],
      ['providers.1.alpha', 'a'],
      ['providers.1.zeta', 'z'],
    ]);
  });

  it('refuses passthrough keys that would shadow, pollute, or break the line', () => {
    expect(
      renderProviderChain([
        {
          provider: 'p',
          passthrough: {
            region: 'shadow',
            constructor: 'x',
            'bad key': 'x',
            'bad:key': 'x',
            empty: '',
            ok: 'y',
          },
        },
      ]),
    ).toEqual([
      ['providers.0.provider', 'p'],
      ['providers.0.ok', 'y'],
    ]);
  });

  it('round-trips through parseProviderChain', () => {
    const entries = [
      { provider: 'azure', baseUrl: 'https://x', apiVersion: '2024-10-21' },
      { provider: 'bedrock', region: 'us-west-2', passthrough: { fooBar: 'keep' } },
    ];
    const lines = renderProviderChain(entries).map(([k, v]) => `${k}: ${v}`);
    expect(lines.every(isProviderChainLine)).toBe(true);
    expect(parseProviderChain(lines)).toEqual(entries);
  });
});

describe('writeConfig and the provider chain', () => {
  const path = join(ethosDir(), 'config.yaml');
  const base = {
    schemaVersion: 1,
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: '',
    personality: 'researcher',
  };

  async function seed() {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      path,
      `${[
        'schemaVersion: 1',
        'provider: anthropic',
        'model: claude-opus-4-7',
        'personality: researcher',
        'providers.0.provider: anthropic',
        'providers.0.fooBar: belongs-to-anthropic',
        'providers.1.provider: bedrock',
        'providers.1.region: eu-west-1',
        'providers.1.fooBar: belongs-to-bedrock',
        'providers.7.orphan: no-provider-here',
      ].join('\n')}\n`,
    );
    return { storage, secrets };
  }

  it('carries unknown fields through an unrelated CLI write', async () => {
    const { storage, secrets } = await seed();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');
    await writeConfig(storage, { ...cfg, personality: 'engineer' }, secrets);

    const after = await readRawConfig(storage);
    expect(after?.personality).toBe('engineer');
    expect(after?.providers).toEqual([
      { provider: 'anthropic', apiKey: '', passthrough: { fooBar: 'belongs-to-anthropic' } },
      {
        provider: 'bedrock',
        apiKey: '',
        region: 'eu-west-1',
        passthrough: { fooBar: 'belongs-to-bedrock' },
      },
    ]);
    // An index with no provider is no entry; its lines have no owner.
    expect(await storage.read(path)).not.toContain('orphan');
  });

  it('moves unknown fields with their entry on reorder', async () => {
    const { storage, secrets } = await seed();
    const cfg = await readRawConfig(storage);
    const [anthropic, bedrock] = cfg?.providers ?? [];
    if (!cfg || !anthropic || !bedrock) throw new Error('fixture chain missing');
    await writeConfig(storage, { ...cfg, providers: [bedrock, anthropic] }, secrets);

    const src = await storage.read(path);
    expect(src).toContain('providers.0.fooBar: belongs-to-bedrock');
    expect(src).toContain('providers.1.fooBar: belongs-to-anthropic');
    expect(src).not.toContain('providers.0.fooBar: belongs-to-anthropic');
    const after = await readRawConfig(storage);
    expect(after?.providers?.[0]).toMatchObject({ provider: 'bedrock', region: 'eu-west-1' });
  });

  it('drops unknown fields with their entry on delete (ethos fallback remove)', async () => {
    const { storage, secrets } = await seed();
    const cfg = await readRawConfig(storage);
    const bedrock = cfg?.providers?.[1];
    if (!cfg || !bedrock) throw new Error('fixture chain missing');
    await writeConfig(storage, { ...cfg, providers: [bedrock] }, secrets);

    const src = await storage.read(path);
    expect(src).not.toContain('belongs-to-anthropic');
    expect(src).toContain('providers.0.fooBar: belongs-to-bedrock');
    expect(src).not.toMatch(/^providers\.1\./m);
  });

  it('externalizes a credential-named unknown field', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        ...base,
        providers: [
          {
            provider: 'bedrock',
            apiKey: '',
            passthrough: { secretKey: 'aws-secret-0123456789abcdef', fooBar: 'plain' },
          },
        ],
      },
      secrets,
    );

    const src = await storage.read(path);
    expect(src).not.toContain('aws-secret-0123456789abcdef');
    expect(src).toContain(`providers.0.secretKey: ${secretRef('providers/0/secretKey')}`);
    expect(src).toContain('providers.0.fooBar: plain');
    expect(await secrets.get('providers/0/secretKey')).toBe('aws-secret-0123456789abcdef');
  });

  // Vault names embed the index an entry had when its key was FIRST stored,
  // and an entry keeps that name when it moves. A key typed for whichever entry
  // later takes the index must not be written over the moved entry's secret.
  it('a key typed at a vacated index does not overwrite a moved entry secret', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        ...base,
        providers: [
          { provider: 'openrouter', apiKey: 'sk-or-first-0123456789' },
          {
            provider: 'anthropic',
            apiKey: 'sk-ant-second-0123456789',
            passthrough: { secretKey: 'aws-second-0123456789' },
          },
        ],
      },
      secrets,
    );
    const stored = await readRawConfig(storage);
    const [first, second] = stored?.providers ?? [];
    if (!stored || !first || !second) throw new Error('fixture chain missing');

    // Reorder, then add a keyed row that lands at index 1 — the index `second`
    // was stored under — with the same provider and field names.
    await writeConfig(
      storage,
      {
        ...stored,
        providers: [
          second,
          {
            provider: 'anthropic',
            apiKey: 'sk-ant-third-0123456789',
            passthrough: { secretKey: 'aws-third-0123456789' },
          },
          first,
        ],
      },
      secrets,
    );

    const resolved = (await readConfig(storage, secrets))?.providers ?? [];
    expect(resolved.map((p) => p.apiKey)).toEqual([
      'sk-ant-second-0123456789',
      'sk-ant-third-0123456789',
      'sk-or-first-0123456789',
    ]);
    const raw = (await readRawConfig(storage))?.providers ?? [];
    expect(await secrets.get(refOf(raw[0]?.passthrough?.secretKey))).toBe('aws-second-0123456789');
    expect(await secrets.get(refOf(raw[1]?.passthrough?.secretKey))).toBe('aws-third-0123456789');
  });
});

describe('externalizeProviderChain counts the top-level key as taken', () => {
  it('a new chain key never lands on the name the top-level key holds', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/1/openai/apiKey', 'sk-top-ORIG');
    await writeConfig(
      storage,
      {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: secretRef('providers/1/openai/apiKey'),
        personality: 'p',
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-0123456789' },
          { provider: 'openai', apiKey: 'sk-oai-NEW-0123456789' },
        ],
      },
      secrets,
    );
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.apiKey).toBe('sk-top-ORIG');
    expect(resolved?.providers?.[1]?.apiKey).toBe('sk-oai-NEW-0123456789');
  });
});

describe('providerChainVersion', () => {
  const a = { provider: 'openai', apiKey: secretRef('providers/0/openai/apiKey') };
  const b = { provider: 'bedrock', region: 'eu-west-1', passthrough: { fooBar: 'x' } };

  it('is stable for the same chain, whatever the object key order', () => {
    expect(providerChainVersion([a, b])).toBe(
      providerChainVersion([{ apiKey: a.apiKey, provider: 'openai' }, { ...b }]),
    );
  });

  it('changes with order, a key reference, or an unmodelled field', () => {
    const base = providerChainVersion([a, b]);
    expect(providerChainVersion([b, a])).not.toBe(base);
    expect(
      providerChainVersion([{ ...a, apiKey: secretRef('providers/9/openai/apiKey') }, b]),
    ).not.toBe(base);
    expect(providerChainVersion([a, { ...b, passthrough: { fooBar: 'y' } }])).not.toBe(base);
  });

  // The two fields model-registry T1.2 added are modelled, so they move the
  // token like every other modelled field — a concurrent edit that only renames
  // an entry or takes it out of the chain is still a conflict.
  it('changes with an entry id or its failover flag', () => {
    const base = providerChainVersion([a, b]);
    expect(providerChainVersion([{ ...a, id: 'openai-work' }, b])).not.toBe(base);
    expect(providerChainVersion([{ ...a, failover: false }, b])).not.toBe(base);
  });
});

describe('a plaintext secret in an unknown chain field', () => {
  // Fail-closed stays: the field used to be dropped on read, so this config
  // booted before. The refusal must say which line and how to fix it.
  it('refuses at boot, naming the config line and the command that fixes it', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: m',
        'personality: researcher',
        'providers.0.provider: openai',
        'providers.1.provider: bedrock',
        'providers.1.awsAccessKeyId: AKIAABCDEFGHIJKLMNOP',
        '',
      ].join('\n'),
    );
    const err = await loadConfigStrict(storage, new InMemorySecretsResolver()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('providers.1.awsAccessKeyId');
    expect(message).toContain('ethos secrets set providers/1/awsAccessKeyId');
    expect(message).toContain(
      `providers.1.awsAccessKeyId: ${secretRef('providers/1/awsAccessKeyId')}`,
    );
  });
});

/** The vault name a stored `${secrets:…}` value points at. */
function refOf(value: string | undefined): string {
  const ref = value?.match(/^\$\{secrets:([^}]+)\}$/)?.[1];
  if (!ref) throw new Error(`not a secret reference: ${value}`);
  return ref;
}
