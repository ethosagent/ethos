// `world.*` config block (plan world-model 4.6): defaults, strict booleans, clamping, and
// verbatim preservation of an unmodelled `world.*` key (known-keys.ts prefix `world.`).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  resolveWorld,
  writeConfig,
} from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];
const parse = (...lines: string[]) => parseConfigYaml([...base, ...lines].join('\n'));
const warningsOf = (...lines: string[]) => configParseNotices(parse(...lines)).warnings;

describe('world config block', () => {
  it('defaults to off with documented defaults when absent', () => {
    const cfg = parse();
    expect(cfg.world).toBeUndefined();
    expect(resolveWorld(cfg)).toEqual({
      enabled: false,
      contextMaxChars: 2400,
      contextHops: 2,
      extraction: 'off',
      proposals: { cap: 500, ttlDays: 30 },
    });
  });

  it('parses every key', () => {
    const cfg = parse(
      'world.enabled: true',
      'world.contextMaxChars: 1000',
      'world.contextHops: 1',
      'world.extraction: propose',
      'world.proposals.cap: 50',
      'world.proposals.ttlDays: 7',
    );
    expect(cfg.world).toEqual({
      enabled: true,
      contextMaxChars: 1000,
      contextHops: 1,
      extraction: 'propose',
      proposals: { cap: 50, ttlDays: 7 },
    });
  });

  it('clamps contextMaxChars to [0, 8000]', () => {
    expect(resolveWorld(parse('world.contextMaxChars: 99999')).contextMaxChars).toBe(8000);
    expect(resolveWorld(parse('world.contextMaxChars: -5')).contextMaxChars).toBe(0);
  });

  it('drops invalid values with a warning and keeps the defaults', () => {
    const lines = [
      'world.enabled: yes',
      'world.contextHops: 3',
      'world.extraction: auto',
      'world.proposals.cap: 0',
      'world.contextMaxChars: lots',
    ];
    const r = resolveWorld(parse(...lines));
    expect(r).toEqual(resolveWorld(parse()));
    const w = warningsOf(...lines).join('\n');
    for (const k of ['enabled', 'contextHops', 'extraction', 'proposals.cap', 'contextMaxChars']) {
      expect(w).toContain(`world.${k}`);
    }
  });

  it('unknown world.* key kept verbatim on write', async () => {
    expect(warningsOf('world.foo: 1').some((w) => w.includes("'world.foo' has no effect"))).toBe(
      true,
    );
    expect(warningsOf('world.foo: 1').filter((w) => w.includes('unknown key'))).toEqual([]);
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [...base, 'world.enabled: true', 'world.foo: 1'].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config missing');
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(src).toContain('world.foo: 1');
    expect(src).toContain('world.enabled: true');
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [...base, 'world.enabled: true', 'world.contextHops: 1', 'world.proposals.ttlDays: 9'].join(
        '\n',
      ),
    );
    const first = await readRawConfig(storage);
    if (!first) throw new Error('config missing');
    await writeConfig(storage, first, new InMemorySecretsResolver());
    const second = await readRawConfig(storage);
    expect(second?.world).toEqual({ enabled: true, contextHops: 1, proposals: { ttlDays: 9 } });
  });
});
