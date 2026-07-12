import { join } from 'node:path';
import {
  EnvSecretsResolver,
  InMemorySecretsResolver,
  InMemoryStorage,
  MergedSecretsResolver,
} from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  readConfig,
  readKeys,
  readRawConfig,
  writeConfig,
} from '../index';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('secrets ref substitution in config', () => {
  async function load(yaml: string, secrets: InMemorySecretsResolver) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readConfig(storage, secrets);
  }

  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    `apiKey: ${secretRef('providers/anthropic/apiKey')}`,
    'personality: researcher',
  ];

  it('resolves apiKey from secrets', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-real-key');
    const cfg = await load(base.join('\n'), secrets);
    expect(cfg?.apiKey).toBe('sk-ant-real-key');
  });

  it('throws when secret ref is missing', async () => {
    const secrets = new InMemorySecretsResolver();
    await expect(load(base.join('\n'), secrets)).rejects.toThrow('Secret not found');
  });

  it('resolves secrets in provider chain', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('providers/openrouter/apiKey', 'sk-or-123');
    const yaml = [
      ...base,
      'providers.0.provider: openrouter',
      `providers.0.apiKey: ${secretRef('providers/openrouter/apiKey')}`,
      'providers.0.model: gpt-5',
    ].join('\n');
    const cfg = await load(yaml, secrets);
    const first = cfg?.providers?.[0];
    expect(first?.apiKey).toBe('sk-or-123');
  });

  it('resolves secrets in telegram bot tokens', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('telegram/token', '123:ABC');
    const yaml = [
      ...base,
      `telegram.bots.0.token: ${secretRef('telegram/token')}`,
      'telegram.bots.0.bind.type: personality',
      'telegram.bots.0.bind.name: researcher',
    ].join('\n');
    const cfg = await load(yaml, secrets);
    expect(cfg?.telegram?.bots[0]?.token).toBe('123:ABC');
  });

  it('resolves secrets in slack app config', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('slack/botToken', 'xoxb-123');
    await secrets.set('slack/appToken', 'xapp-456');
    await secrets.set('slack/signingSecret', 'sec-789');
    const yaml = [
      ...base,
      `slack.apps.0.botToken: ${secretRef('slack/botToken')}`,
      `slack.apps.0.appToken: ${secretRef('slack/appToken')}`,
      `slack.apps.0.signingSecret: ${secretRef('slack/signingSecret')}`,
      'slack.apps.0.bind.type: personality',
      'slack.apps.0.bind.name: researcher',
    ].join('\n');
    const cfg = await load(yaml, secrets);
    const app = cfg?.slack?.apps[0];
    expect(app?.botToken).toBe('xoxb-123');
    expect(app?.appToken).toBe('xapp-456');
    expect(app?.signingSecret).toBe('sec-789');
  });

  it('resolves secrets in auxiliary compression apiKey', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('auxiliary/compression-key', 'sk-aux-comp');
    const yaml = [
      ...base,
      'auxiliary.compression.model: claude-haiku-4-5-20251001',
      `auxiliary.compression.apiKey: ${secretRef('auxiliary/compression-key')}`,
    ].join('\n');
    const cfg = await load(yaml, secrets);
    expect(cfg?.auxiliary?.compression?.apiKey).toBe('sk-aux-comp');
  });

  it('does not mutate original parsed config', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-resolved');
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      `provider: anthropic\nmodel: m\napiKey: ${secretRef('providers/anthropic/apiKey')}\npersonality: p\n`,
    );
    const raw = await readRawConfig(storage);
    const resolved = await readConfig(storage, secrets);
    expect(raw?.apiKey).toBe(secretRef('providers/anthropic/apiKey'));
    expect(resolved?.apiKey).toBe('sk-resolved');
  });

  it('readRawConfig returns unresolved refs', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      'provider: anthropic\nmodel: claude-opus-4-7\napiKey: sk-plain\npersonality: p\n',
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.apiKey).toBe('sk-plain');
  });
});

describe('readKeys with secrets resolution', () => {
  it('resolves secret refs in key apiKey fields', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('rotation/backup', 'sk-ant-rotated');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'keys.json'),
      JSON.stringify([{ apiKey: secretRef('rotation/backup'), priority: 50, label: 'backup' }]),
    );
    const keys = await readKeys(storage, secrets);
    expect(keys[0]?.apiKey).toBe('sk-ant-rotated');
  });

  it('works without secrets resolver', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'keys.json'),
      JSON.stringify([{ apiKey: 'sk-plain', priority: 50 }]),
    );
    const keys = await readKeys(storage);
    expect(keys[0]?.apiKey).toBe('sk-plain');
  });
});

// ---------------------------------------------------------------------------
// New tests: env-based resolution via MergedSecretsResolver
// ---------------------------------------------------------------------------

describe('env-only resolution via MergedSecretsResolver', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  async function loadWithMerged(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    return readConfig(storage, merged);
  }

  const baseYaml = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    `apiKey: ${['${', 'secrets:providers/anthropic/apiKey}'].join('')}`,
    'personality: researcher',
  ].join('\n');

  it('resolves apiKey from process.env via MergedSecretsResolver', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    const cfg = await loadWithMerged(baseYaml);
    expect(cfg?.apiKey).toBe('sk-ant-from-env');
  });

  it('env overrides on-disk file value', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-priority';
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), baseYaml);
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-fallback');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    const cfg = await readConfig(storage, merged);
    expect(cfg?.apiKey).toBe('env-priority');
  });

  it('boot failure message for known ref contains env var name', async () => {
    // No env var set, no file secret → should throw with env var hint
    await expect(loadWithMerged(baseYaml)).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('boot failure message for known ref contains all 3 resolution paths', async () => {
    let err: Error | undefined;
    try {
      await loadWithMerged(baseYaml);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('~/.ethos/.env');
    expect(err?.message).toContain('environment variable ANTHROPIC_API_KEY');
    expect(err?.message).toContain('ethos secrets set');
  });
});

// ---------------------------------------------------------------------------
// AWS secrets config round-trip
// ---------------------------------------------------------------------------

describe('aws.secrets config round-trip', () => {
  it('aws.secrets config round-trips through write/parse', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-test',
      personality: 'researcher',
      aws: {
        secrets: {
          enabled: true,
          region: 'us-west-2',
          prefix: 'ethos/prod',
          endpoint: 'http://localhost:4566',
        },
      },
    };

    await writeConfig(storage, config);
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('aws.secrets.enabled: true');
    expect(raw).toContain('aws.secrets.region: us-west-2');
    expect(raw).toContain('aws.secrets.prefix: ethos/prod');
    expect(raw).toContain('aws.secrets.endpoint: http://localhost:4566');

    // Re-parse
    const reparsed = await readRawConfig(storage);
    expect(reparsed?.aws?.secrets?.enabled).toBe(true);
    expect(reparsed?.aws?.secrets?.region).toBe('us-west-2');
    expect(reparsed?.aws?.secrets?.prefix).toBe('ethos/prod');
    expect(reparsed?.aws?.secrets?.endpoint).toBe('http://localhost:4566');
  });
});
