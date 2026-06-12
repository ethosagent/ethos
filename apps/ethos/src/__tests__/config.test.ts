import { homedir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../config';

describe('ethosDir', () => {
  afterEach(() => {
    delete process.env.ETHOS_STATE_DIR;
  });

  it('returns ~/.ethos when ETHOS_STATE_DIR is not set', () => {
    delete process.env.ETHOS_STATE_DIR;
    expect(ethosDir()).toBe(join(homedir(), '.ethos'));
  });

  it('returns ETHOS_STATE_DIR when set', () => {
    process.env.ETHOS_STATE_DIR = '/tmp/custom-ethos';
    expect(ethosDir()).toBe('/tmp/custom-ethos');
  });
});

async function loadYaml(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — whatsapp.<n>.<field>', () => {
  it('parses an indexed whatsapp entry into config.whatsapp', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'whatsapp.0.id: wa1',
        'whatsapp.0.default_mode: all',
        'whatsapp.0.allowed_numbers: 111@s.whatsapp.net,222@s.whatsapp.net',
      ].join('\n'),
    );
    expect(cfg.whatsapp).toEqual([
      {
        id: 'wa1',
        default_mode: 'all',
        allowed_numbers: ['111@s.whatsapp.net', '222@s.whatsapp.net'],
      },
    ]);
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      whatsapp: [
        {
          id: 'wa1',
          default_mode: 'all',
          allowed_numbers: ['111@s.whatsapp.net', '222@s.whatsapp.net'],
        },
      ],
    };
    await writeConfig(storage, original);

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.id: wa1');
    expect(raw).toContain('whatsapp.0.default_mode: all');
    expect(raw).toContain('whatsapp.0.allowed_numbers: 111@s.whatsapp.net,222@s.whatsapp.net');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp).toEqual(original.whatsapp);
  });

  it('round-trips phone_number for phone-number pairing', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      whatsapp: [{ id: 'wa1', default_mode: 'all', phone_number: '+1 555 123 4567' }],
    };
    await writeConfig(storage, original);

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.phone_number: +1 555 123 4567');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp).toEqual(original.whatsapp);
  });

  it('leaves config.whatsapp undefined when no whatsapp keys are present', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
      ].join('\n'),
    );
    expect(cfg.whatsapp).toBeUndefined();
  });

  it('parses an optional bind and round-trips it', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'whatsapp.0.id: wa1',
        'whatsapp.0.bind.type: personality',
        'whatsapp.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(cfg.whatsapp?.[0]?.bind).toEqual({ type: 'personality', name: 'researcher' });

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg);
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.bind.type: personality');
    expect(raw).toContain('whatsapp.0.bind.name: researcher');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp?.[0]?.bind).toEqual({
      type: 'personality',
      name: 'researcher',
    });
  });

  it('leaves bind undefined for a whatsapp entry with no bind keys', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'whatsapp.0.id: wa1',
        'whatsapp.0.default_mode: all',
      ].join('\n'),
    );
    expect(cfg.whatsapp?.[0]?.bind).toBeUndefined();
  });
});

describe('parseConfigYaml — admin.enabled', () => {
  it('parses admin.enabled: true into config.admin', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'admin.enabled: true',
      ].join('\n'),
    );
    expect(cfg.admin).toEqual({ enabled: true });
  });

  it('parses admin.enabled: false into config.admin', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'admin.enabled: false',
      ].join('\n'),
    );
    expect(cfg.admin).toEqual({ enabled: false });
  });

  it('leaves config.admin undefined when the key is absent (default off)', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
      ].join('\n'),
    );
    expect(cfg.admin).toBeUndefined();
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      admin: { enabled: true },
    };
    await writeConfig(storage, original);

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('admin.enabled: true');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.admin).toEqual({ enabled: true });
  });
});
