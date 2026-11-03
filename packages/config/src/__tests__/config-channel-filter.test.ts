import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  readRawConfig,
  writeConfig,
} from '../index';

// channel_filter.<platform>.enable — per-platform explicit on/off switch.

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — channel_filter.<platform>.enable', () => {
  it('parses enable: false → channelFilter.telegram.enabled === false', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.enable: false',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram).toEqual({ enabled: false });
  });

  it('parses enable: true → channelFilter.telegram.enabled === true', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.enable: true',
        'channel_filter.telegram.ownerUserId: owner-1',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram.enabled).toBe(true);
    expect(cfg.channelFilter?.telegram.ownerUserId).toBe('owner-1');
  });

  it('leaves enabled unset when the enable key is absent', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.ownerUserId: owner-1',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram.enabled).toBeUndefined();
  });
});

describe('writeConfig — channel_filter.<platform>.enable round-trip', () => {
  it('serializes enable: false and round-trips', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      channelFilter: { telegram: { enabled: false, ownerUserId: 'owner-1' } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('channel_filter.telegram.enable: false');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.channelFilter?.telegram.enabled).toBe(false);
  });

  it('does not emit the enable line when enabled is true', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk',
        personality: 'researcher',
        channelFilter: { telegram: { enabled: true, ownerUserId: 'owner-1' } },
      },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('channel_filter.telegram.enable');
  });

  it('does not emit the enable line when enabled is unset', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk',
        personality: 'researcher',
        channelFilter: { telegram: { ownerUserId: 'owner-1' } },
      },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('channel_filter.telegram.enable');
  });
});

describe('channel_filter.<platform>.dmPolicy: decline', () => {
  const base: EthosConfig = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'sk',
    personality: 'researcher',
  };

  async function roundTrip(channelFilter: EthosConfig['channelFilter']) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, { ...base, channelFilter }, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    const back = await readRawConfig(storage);
    return { raw, back };
  }

  it('dmPolicy: decline parses and round-trips', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.ownerUserId: 1234567',
        'channel_filter.telegram.dmPolicy: decline',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram).toEqual({ ownerUserId: '1234567', dmPolicy: 'decline' });

    const { raw, back } = await roundTrip(cfg.channelFilter);
    expect(raw).toContain('channel_filter.telegram.dmPolicy: decline');
    expect(back?.channelFilter?.telegram.dmPolicy).toBe('decline');
  });

  it("a declineMessage containing ': ' and '#' round-trips", async () => {
    const message = 'Thanks: this is private # I can\'t reply. Path C:\\tmp "x"';
    const { back } = await roundTrip({
      telegram: { ownerUserId: 'o', dmPolicy: 'decline', declineMessage: message },
    });
    expect(back?.channelFilter?.telegram.declineMessage).toBe(message);

    const hand = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.dmPolicy: decline',
        'channel_filter.telegram.declineMessage: "Thanks for writing. This assistant is private, so I can\'t reply: # ok"',
      ].join('\n'),
    );
    expect(hand.channelFilter?.telegram.declineMessage).toBe(
      "Thanks for writing. This assistant is private, so I can't reply: # ok",
    );
  });

  it('a declineMessage over 500 characters warns and is ignored', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.dmPolicy: decline',
        `channel_filter.telegram.declineMessage: ${'x'.repeat(501)}`,
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram.declineMessage).toBeUndefined();
    expect(cfg.channelFilter?.telegram.dmPolicy).toBe('decline');
    expect(configParseNotices(cfg).warnings).toContain(
      'channel_filter.telegram.declineMessage is longer than 500 characters; using the default',
    );
  });
});
