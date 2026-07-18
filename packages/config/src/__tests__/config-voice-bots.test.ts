import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  validateBotBindings,
  writeConfig,
} from '../index';

// Voice bot binding schema — plan/phases/gap-voice-realtime.md §3(b),(e).
// Mirrors telegram.bots[] but keyed on a room/number `match` pattern.

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

async function loadStrict(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return loadConfigStrict(storage);
}

describe('parseConfigYaml — voice.bots[]', () => {
  it('parses a multi-bot voice config with mixed bindings', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +15551234567',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
        'voice.bots.1.id: reception',
        'voice.bots.1.match: room-support-*',
        'voice.bots.1.bind.type: team',
        'voice.bots.1.bind.name: eng',
      ].join('\n'),
    );

    expect(cfg.voice?.bots).toHaveLength(2);
    expect(cfg.voice?.bots[0]).toEqual({
      match: '+15551234567',
      bind: { type: 'personality', name: 'researcher' },
    });
    expect(cfg.voice?.bots[1]).toEqual({
      id: 'reception',
      match: 'room-support-*',
      bind: { type: 'team', name: 'eng' },
    });
  });

  it('honors bind.allowSlashSwitch', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'voice.bots.0.match: +1999',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
        'voice.bots.0.bind.allowSlashSwitch: true',
      ].join('\n'),
    );

    expect(cfg.voice?.bots[0].bind).toEqual({
      type: 'personality',
      name: 'researcher',
      allowSlashSwitch: true,
    });
  });

  it('round-trips through writeConfig -> readRawConfig', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [
          {
            id: 'reception',
            match: '+15551234567',
            bind: { type: 'personality', name: 'researcher' },
          },
          { match: 'room-*', bind: { type: 'team', name: 'eng', allowSlashSwitch: true } },
        ],
      },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, original);
    const reloaded = await readRawConfig(storage);

    expect(reloaded?.voice?.bots).toEqual(original.voice?.bots);
  });

  it('omits malformed entries from the parsed list', async () => {
    // Entry 0 has a match but no bind — must not appear; entry 1 is well-formed.
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'voice.bots.0.match: +1000',
        'voice.bots.1.match: +2000',
        'voice.bots.1.bind.type: personality',
        'voice.bots.1.bind.name: researcher',
      ].join('\n'),
    );

    expect(cfg.voice?.bots).toHaveLength(1);
    expect(cfg.voice?.bots[0].match).toBe('+2000');
  });
});

describe('loadConfigStrict — voice.bots malformed entries surface as parseErrors', () => {
  it('reports a missing match field', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'match'"))).toBe(
      true,
    );
  });

  it('reports a typo in bind.type', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +1555',
        'voice.bots.0.bind.type: personailty',
        'voice.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("'personailty'"))).toBe(true);
    expect(result?.config.voice?.bots ?? []).toHaveLength(0);
  });

  it('returns empty parseErrors for a well-formed config', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +1555',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors).toEqual([]);
    expect(result?.config.voice?.bots).toHaveLength(1);
  });
});

describe('validateBotBindings — voice.bots[]', () => {
  const deps = {
    personalityIds: new Set(['researcher']),
    teamNames: new Set(['eng']),
  };

  it('accepts a voice bot bound to a known personality', () => {
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: { bots: [{ match: '+1555', bind: { type: 'personality', name: 'researcher' } }] },
    };
    expect(validateBotBindings(config, deps)).toEqual([]);
  });

  it('rejects a voice bot bound to an unknown personality', () => {
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: { bots: [{ match: '+1555', bind: { type: 'personality', name: 'ghost' } }] },
    };
    const errors = validateBotBindings(config, deps);
    expect(errors.some((e) => e.includes("bind.name='ghost' is not a known personality"))).toBe(
      true,
    );
  });

  it('rejects two voice bots with a colliding derived botKey', () => {
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [
          { match: '+1555', bind: { type: 'personality', name: 'researcher' } },
          { match: '+1555', bind: { type: 'personality', name: 'researcher' } },
        ],
      },
    };
    const errors = validateBotBindings(config, deps);
    expect(errors.some((e) => e.includes('duplicate botKey'))).toBe(true);
  });
});
