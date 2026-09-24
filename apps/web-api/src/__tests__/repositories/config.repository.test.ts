import { join } from 'node:path';
import { ethosDir, readRawConfig, writeConfig } from '@ethosagent/config';
import { deriveBotKey } from '@ethosagent/core';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';

const DATA = '/data';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('ConfigRepository', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let repo: ConfigRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
  });

  it('preserves dotted passthrough keys on read and write', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      join(DATA, 'config.yaml'),
      `${[
        'provider: anthropic',
        'telegram.bots.0.token: 123:ABC',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
        'telegram.bots.1.token: 456:DEF',
        'telegram.bots.1.bind.type: team',
        'telegram.bots.1.bind.name: eng',
      ].join('\n')}\n`,
    );

    const config = await repo.read();
    expect(config?.passthrough['telegram.bots.0.token']).toBe('123:ABC');
    expect(config?.passthrough['telegram.bots.0.bind.type']).toBe('personality');
    expect(config?.passthrough['telegram.bots.0.bind.name']).toBe('researcher');
    expect(config?.passthrough['telegram.bots.1.token']).toBe('456:DEF');

    // Update an unrelated field — dotted keys must survive
    await repo.update({ model: 'claude-opus-4-7' });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    // The token is preserved, but as a vault reference — never as a literal.
    // The ref is keyed by the bot's stable botKey (what PlatformsRepository
    // mints for the same token), not by array position.
    const botKey = deriveBotKey('123:ABC');
    expect(yaml).toContain(
      `telegram.bots.0.token: "${secretRef(`telegram/bots/${botKey}/token`)}"`,
    );
    expect(yaml).not.toContain('123:ABC');
    expect(await secrets.get(`telegram/bots/${botKey}/token`)).toBe('123:ABC');
    expect(yaml).toContain('telegram.bots.1.bind.name: eng');
  });

  it('reads providers.N.field lines into a providers array', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-primary',
        'providers.0.provider: anthropic',
        'providers.0.apiKey: sk-ant-primary',
        'providers.0.model: claude-opus-4-7',
        'providers.1.provider: openrouter',
        'providers.1.apiKey: sk-or-fallback',
        'providers.1.model: gpt-4',
        'providers.1.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );

    const config = await repo.read();
    expect(config?.providers).toHaveLength(2);
    expect(config?.providers[0]).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-primary',
      model: 'claude-opus-4-7',
    });
    expect(config?.providers[1]).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-or-fallback',
      model: 'gpt-4',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    // Verify they don't leak into passthrough
    expect(config?.passthrough['providers.0.provider']).toBeUndefined();
    expect(config?.passthrough['providers.1.apiKey']).toBeUndefined();
  });

  it('round-trips providers through write then read', async () => {
    await repo.update({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-ant-primary',
      providers: [
        { provider: 'anthropic', apiKey: 'sk-ant-primary', model: 'claude-opus-4-7' },
        {
          provider: 'openrouter',
          apiKey: 'sk-or-fallback',
          model: 'gpt-4',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
      ],
    });

    const config = await repo.read();
    expect(config?.providers).toHaveLength(2);
    expect(config?.providers[0]?.provider).toBe('anthropic');
    expect(config?.providers[0]?.model).toBe('claude-opus-4-7');
    expect(config?.providers[1]?.provider).toBe('openrouter');
    expect(config?.providers[1]?.baseUrl).toBe('https://openrouter.ai/api/v1');

    // Verify the raw YAML has the indexed keys
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('providers.0.provider: anthropic');
    expect(yaml).toContain('providers.1.provider: openrouter');
    expect(yaml).toContain('providers.1.baseUrl: "https://openrouter.ai/api/v1"');
  });

  it('update with providers replaces the entire array', async () => {
    await repo.update({
      providers: [
        { provider: 'anthropic', apiKey: 'sk-ant-1' },
        { provider: 'openrouter', apiKey: 'sk-or-1' },
      ],
    });
    // Now replace with a single provider
    await repo.update({
      providers: [{ provider: 'ollama', model: 'llama3' }],
    });
    const config = await repo.read();
    expect(config?.providers).toHaveLength(1);
    expect(config?.providers[0]?.provider).toBe('ollama');
    // Old providers should be gone
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).not.toContain('openrouter');
  });

  // The format is line-based: a control character cannot be written so that
  // it reads back (and a newline would smuggle in a new key). Refused, naming
  // the field, before the file is touched (`assertWritableConfigLines`).
  it('refuses a value with a control character, naming the field', async () => {
    await repo.update({ model: 'claude-opus-4-7' });
    const before = await storage.read(join(DATA, 'config.yaml'));
    const err = await repo
      .update({ passthrough: { 'display.note': 'line\nfs_reach: /' } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(String((err as { cause?: string }).cause)).toContain("'display.note'");
    expect(await storage.read(join(DATA, 'config.yaml'))).toBe(before);
  });

  it('writes `\\` and `"` so the reader gets them back, over repeated saves', async () => {
    const value = ' C:\\srv\\\\share "x" #1: a ';
    await repo.update({ baseUrl: value });
    for (let i = 0; i < 3; i++) await repo.update({ verbosity: i % 2 ? 'concise' : 'verbose' });
    expect((await repo.read())?.baseUrl).toBe(value);
  });

  it('writes config.yaml with 0o600 so plaintext apiKeys are not world-readable', async () => {
    const path = join(DATA, 'config.yaml');

    // update() (the common write path)
    await repo.update({ apiKey: 'sk-ant-secret' });
    expect(storage.getMode(path)).toBe(0o600);

    // deletePassthroughKeys() (the other write path)
    await repo.deletePassthroughKeys(['nonexistent']);
    expect(storage.getMode(path)).toBe(0o600);
  });

  it('round-trips voice base URL, model, and free-form voice id', async () => {
    await repo.update({
      voiceProvider: 'local-stt',
      voiceBaseUrl: 'http://localhost:8000/v1',
      voiceModel: 'whisper-large-v3',
      voiceTtsProvider: 'local-tts',
      voiceTtsBaseUrl: 'http://localhost:8880/v1',
      voiceTtsModel: 'kokoro',
      voiceTtsVoice: 'af_bella',
    });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('auxiliary.asr.baseUrl: "http://localhost:8000/v1"');
    expect(yaml).toContain('auxiliary.asr.model: whisper-large-v3');
    expect(yaml).toContain('auxiliary.tts.baseUrl: "http://localhost:8880/v1"');
    expect(yaml).toContain('auxiliary.tts.model: kokoro');
    expect(yaml).toContain('auxiliary.tts.voice: af_bella');

    const config = await repo.read();
    expect(config?.voiceProvider).toBe('local-stt');
    expect(config?.voiceBaseUrl).toBe('http://localhost:8000/v1');
    expect(config?.voiceModel).toBe('whisper-large-v3');
    expect(config?.voiceTtsProvider).toBe('local-tts');
    expect(config?.voiceTtsBaseUrl).toBe('http://localhost:8880/v1');
    expect(config?.voiceTtsModel).toBe('kokoro');
    expect(config?.voiceTtsVoice).toBe('af_bella');
  });

  it('does not duplicate voice keys into passthrough on round-trip', async () => {
    await repo.update({
      voiceProvider: 'local-stt',
      voiceBaseUrl: 'http://localhost:8000/v1',
      voiceModel: 'whisper-large-v3',
    });
    const config = await repo.read();
    expect(config?.passthrough['auxiliary.asr.baseUrl']).toBeUndefined();
    expect(config?.passthrough['auxiliary.asr.model']).toBeUndefined();
  });

  it('deletePassthroughKeys removes dotted keys', async () => {
    await repo.update({
      passthrough: {
        'telegram.bots.0.token': 'tok',
        'telegram.bots.0.bind.type': 'personality',
        'telegram.bots.0.bind.name': 'researcher',
        telegramToken: 'old',
      },
    });
    await repo.deletePassthroughKeys([
      'telegram.bots.0.token',
      'telegram.bots.0.bind.type',
      'telegram.bots.0.bind.name',
    ]);
    const config = await repo.read();
    expect(config?.passthrough['telegram.bots.0.token']).toBeUndefined();
    expect(config?.passthrough.telegramToken).toBe(secretRef('telegram/token'));
    expect(await secrets.get('telegram/token')).toBe('old');
  });

  it('preserves open toolSettings keys (search_console) across read-modify-write', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'toolSettings._default.search_console.secret: gsc-default',
        'toolSettings.scout.search_console.secret: gsc-scout',
        'toolSettings.scout.dataforseo.secret: seo-scout',
        '',
      ].join('\n'),
    );

    const config = await repo.read();
    expect(config?.toolSettings._default).toEqual({
      search_console: { secret: 'gsc-default' },
    });
    expect(config?.toolSettings.scout).toEqual({
      search_console: { secret: 'gsc-scout' },
      dataforseo: { secret: 'seo-scout' },
    });

    await repo.update({ model: 'claude-sonnet-4-6' });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('toolSettings._default.search_console.secret: gsc-default');
    expect(yaml).toContain('toolSettings.scout.search_console.secret: gsc-scout');
    expect(yaml).toContain('toolSettings.scout.dataforseo.secret: seo-scout');
  });
});

// F01 (plan/phases/architecture-suggestions-2026-09-10.md): the CLI writer and
// this repository share one `providers.<n>.*` codec (`parseProviderChain` /
// `renderProviderChain` in @ethosagent/config), so a web save cannot drop a
// field the CLI wrote, and the runtime reader (`readRawConfig`) sees it after.
describe('ConfigRepository — provider chain written by the CLI', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let repo: ConfigRepository;
  const path = join(ethosDir(), 'config.yaml');

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    repo = new ConfigRepository({ dataDir: ethosDir(), storage, secrets });
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: '',
        personality: 'researcher',
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-chain-0123456789abcdef' },
          { provider: 'bedrock', apiKey: '', region: 'eu-west-1', awsProfile: 'sso-prod' },
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
    // A field this release does not model — hand-added by the operator, or
    // written by a newer ethos. It belongs to entry 1 (bedrock).
    await storage.write(path, `${await storage.read(path)}providers.1.fooBar: keep-me\n`);
  });

  it('an unrelated web update keeps supported and unknown providers.N.* fields', async () => {
    await repo.update({ verbosity: 'verbose' });

    const yaml = await storage.read(path);
    expect(yaml).toContain('verbosity: verbose');
    expect(yaml).toContain('providers.1.fooBar: keep-me');

    const cfg = await readRawConfig(storage);
    expect(cfg?.providers).toHaveLength(3);
    expect(cfg?.providers?.[1]).toMatchObject({
      provider: 'bedrock',
      region: 'eu-west-1',
      awsProfile: 'sso-prod',
      passthrough: { fooBar: 'keep-me' },
    });
    expect(cfg?.providers?.[2]).toMatchObject({
      provider: 'azure',
      baseUrl: 'https://example.openai.azure.com',
      apiVersion: '2024-10-21',
    });
    // Secret values stay in the vault; the file holds references only.
    expect(cfg?.providers?.[0]?.apiKey).toBe(secretRef('providers/0/anthropic/apiKey'));
    expect(cfg?.providers?.[2]?.apiKey).toBe(secretRef('providers/2/azure/apiKey'));
    expect(yaml).not.toContain('sk-ant-chain-0123456789abcdef');
    expect(yaml).not.toContain('azure-key-0123456789abcdef');
  });

  it('a reorder moves unknown fields with their entry', async () => {
    const [anthropic, bedrock, azure] = (await repo.read())?.providers ?? [];
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    await repo.update({ providers: [bedrock, anthropic, azure] });

    const cfg = await readRawConfig(storage);
    expect(cfg?.providers?.map((p) => p.provider)).toEqual(['bedrock', 'anthropic', 'azure']);
    expect(cfg?.providers?.[0]).toMatchObject({
      provider: 'bedrock',
      region: 'eu-west-1',
      awsProfile: 'sso-prod',
      passthrough: { fooBar: 'keep-me' },
    });
    expect(cfg?.providers?.[1]?.passthrough).toBeUndefined();
    expect(cfg?.providers?.[2]?.passthrough).toBeUndefined();
    // The key reference moves with its entry as well.
    expect(cfg?.providers?.[1]?.apiKey).toBe(secretRef('providers/0/anthropic/apiKey'));
    const yaml = await storage.read(path);
    expect(yaml).toContain('providers.0.fooBar: keep-me');
    expect(yaml).not.toContain('providers.1.fooBar');
  });

  it('deleting an entry drops its unknown fields with it', async () => {
    const current = await repo.read();
    await repo.update({
      providers: (current?.providers ?? []).filter((p) => p.provider !== 'bedrock'),
    });

    const yaml = await storage.read(path);
    expect(yaml).not.toContain('fooBar');
    expect(yaml).not.toContain('eu-west-1');
    const cfg = await readRawConfig(storage);
    expect(cfg?.providers?.map((p) => p.provider)).toEqual(['anthropic', 'azure']);
    expect(cfg?.providers?.[1]?.passthrough).toBeUndefined();
    expect(cfg?.providers?.[1]?.apiVersion).toBe('2024-10-21');
  });

  it('externalizes a credential-named unknown field instead of persisting its value', async () => {
    await storage.write(
      path,
      `${await storage.read(path)}providers.1.secretKey: aws-secret-0123456789abcdef\n`,
    );

    await repo.update({ verbosity: 'concise' });

    const yaml = await storage.read(path);
    expect(yaml).not.toContain('aws-secret-0123456789abcdef');
    expect(yaml).toContain(`providers.1.secretKey: "${secretRef('providers/1/secretKey')}"`);
    expect(await secrets.get('providers/1/secretKey')).toBe('aws-secret-0123456789abcdef');
    const cfg = await readRawConfig(storage);
    expect(cfg?.providers?.[1]?.passthrough).toEqual({
      fooBar: 'keep-me',
      secretKey: secretRef('providers/1/secretKey'),
    });
  });
});

// openclaw-9.5-adoption item 7 (D32) — `providers.<n>.serverCompaction` and its
// trigger are owned by the shared chain codec, so a web save neither drops nor
// rewrites them, and a chain written through the repository carries them.
describe('ConfigRepository — providers.<n>.serverCompaction', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let repo: ConfigRepository;
  const path = join(ethosDir(), 'config.yaml');

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    repo = new ConfigRepository({ dataDir: ethosDir(), storage, secrets });
    // Written by the CLI writer.
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: '',
        personality: 'researcher',
        providers: [
          {
            provider: 'anthropic',
            apiKey: '',
            serverCompaction: true,
            serverCompactionTriggerTokens: 120_000,
          },
          { provider: 'openrouter', apiKey: '' },
        ],
      },
      secrets,
    );
  });

  it('an unrelated web update keeps both lines', async () => {
    await repo.update({ verbosity: 'verbose' });
    const yaml = await storage.read(path);
    expect(yaml).toContain('providers.0.serverCompaction: true');
    expect(yaml).toContain('providers.0.serverCompactionTriggerTokens: 120000');
    expect((await repo.read())?.providers?.[0]).toMatchObject({
      serverCompaction: true,
      serverCompactionTriggerTokens: 120_000,
    });
  });

  it('a chain written through the repository renders them, and the CLI reader reads them', async () => {
    const [anthropic, openrouter] = (await repo.read())?.providers ?? [];
    if (!anthropic || !openrouter) throw new Error('chain did not read back');
    await repo.update({ providers: [openrouter, anthropic] });
    const cfg = await readRawConfig(storage);
    expect(cfg?.providers?.[1]).toMatchObject({
      provider: 'anthropic',
      serverCompaction: true,
      serverCompactionTriggerTokens: 120_000,
    });
    expect(cfg?.providers?.[0]?.serverCompaction).toBeUndefined();
  });
});
