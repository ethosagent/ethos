import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  writeConfig,
} from '../index';

// plan personality-memory-boundary D9 / step 3 — trusted rooms,
// `gateway.private_chats.<platform>: <chatId,...>`. Parsed into
// `EthosConfig.gateway.privateChats`; deliberately outside `channel_filter.*`
// so listing a room never turns the sender filter on.

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk',
  'personality: researcher',
];

async function storageWith(lines: string[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  return storage;
}

async function load(storage: InMemoryStorage): Promise<EthosConfig> {
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — gateway.private_chats', () => {
  it('parses a comma list per platform, trimmed and de-duplicated', () => {
    const cfg = parseConfigYaml(
      [
        ...BASE,
        'gateway.private_chats.telegram: -1001, -1002 ,-1001',
        'gateway.private_chats.slack: C0TEAM',
      ].join('\n'),
    );
    expect(cfg.gateway?.privateChats).toEqual({
      telegram: ['-1001', '-1002'],
      slack: ['C0TEAM'],
    });
    expect(configParseNotices(cfg).warnings).toEqual([]);
  });

  it('is absent when no key is set', () => {
    const cfg = parseConfigYaml(BASE.join('\n'));
    expect(cfg.gateway?.privateChats).toBeUndefined();
  });

  it('has no channel_filter side effect', () => {
    const cfg = parseConfigYaml([...BASE, 'gateway.private_chats.telegram: -1001'].join('\n'));
    expect(cfg.channelFilter).toBeUndefined();
  });

  it('keeps any platform name, so a plugin platform can list rooms', () => {
    const cfg = parseConfigYaml([...BASE, 'gateway.private_chats.matrix: !room:hs'].join('\n'));
    expect(cfg.gateway?.privateChats).toEqual({ matrix: ['!room:hs'] });
  });

  it('coexists with the other gateway.* knobs', () => {
    const cfg = parseConfigYaml(
      [
        ...BASE,
        'gateway.maxInboundMediaBytes: 2048',
        'gateway.private_chats.whatsapp: 1203630@g.us',
      ].join('\n'),
    );
    expect(cfg.gateway).toEqual({
      maxInboundMediaBytes: 2048,
      privateChats: { whatsapp: ['1203630@g.us'] },
    });
  });
});

describe('parseConfigYaml — gateway.private_chats bad values warn, never fail', () => {
  it('drops an id containing whitespace with a warning, keeps the rest', () => {
    const cfg = parseConfigYaml(
      [...BASE, 'gateway.private_chats.telegram: -1001 -1002,-1003'].join('\n'),
    );
    expect(cfg.gateway?.privateChats).toEqual({ telegram: ['-1003'] });
    const { errors, warnings } = configParseNotices(cfg);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      "gateway.private_chats.telegram: '-1001 -1002' is not a chat id (contains whitespace) — ignored. Separate ids with commas.",
    ]);
  });

  it('drops an entry that lists no ids with a warning', () => {
    const cfg = parseConfigYaml([...BASE, 'gateway.private_chats.slack: , ,'].join('\n'));
    expect(cfg.gateway).toBeUndefined();
    expect(configParseNotices(cfg).warnings).toEqual([
      'gateway.private_chats.slack: lists no chat ids — ignored. Expected <chatId,...>.',
    ]);
  });

  it('a malformed key is not claimed and does not throw', () => {
    const cfg = parseConfigYaml([...BASE, 'gateway.private_chats: -1001'].join('\n'));
    expect(cfg.gateway?.privateChats).toBeUndefined();
  });
});

describe('writeConfig — gateway.private_chats round-trip', () => {
  it('parse → render → parse is stable', async () => {
    const storage = await storageWith([
      'gateway.private_chats.telegram: -1001,-1002',
      'gateway.private_chats.discord: 112233445566',
    ]);
    const first = await load(storage);
    await writeConfig(storage, first, new InMemorySecretsResolver());
    const yaml = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(yaml).toContain('gateway.private_chats.telegram: -1001,-1002');
    expect(yaml).toContain('gateway.private_chats.discord: 112233445566');
    const second = await load(storage);
    expect(second.gateway?.privateChats).toEqual(first.gateway?.privateChats);
  });

  it('an unrelated CLI save keeps the list', async () => {
    const storage = await storageWith(['gateway.private_chats.telegram: -1001']);
    const cfg = await load(storage);
    await writeConfig(storage, { ...cfg, personality: 'engineer' }, new InMemorySecretsResolver());
    const after = await load(storage);
    expect(after.personality).toBe('engineer');
    expect(after.gateway?.privateChats).toEqual({ telegram: ['-1001'] });
  });

  it('clearing the field removes the line', async () => {
    const storage = await storageWith(['gateway.private_chats.telegram: -1001']);
    const cfg = await load(storage);
    await writeConfig(storage, { ...cfg, gateway: undefined }, new InMemorySecretsResolver());
    const yaml = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(yaml).not.toContain('gateway.private_chats');
  });
});
