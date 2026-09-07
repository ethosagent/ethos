import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

/**
 * A config.yaml carrying three classes of line:
 *   1. keys `writeConfig` serializes unconditionally,
 *   2. keys this package models nowhere — `apps/web-api`'s ConfigRepository
 *      writes some of them (`approvalMode`, `debugMode`, `contextLayering`),
 *      operators hand-write others,
 *   3. keys it parses but only serializes at their NON-default value, so an
 *      identity round-trip drops them (`display.resume_hint: true`).
 *
 * Classes 2 and 3 are what `ethos personality set` deleted.
 */
const ORIGINAL = [
  'schemaVersion: 1',
  'provider: anthropic',
  'model: claude-opus-4-7',
  'personality: default',
  'approvalMode: manual',
  'debugMode: false',
  'contextLayering: true',
  'display.voice_chime: false',
  'display.voice_speech_threshold: 0.6',
  'background.pi_image: ghcr.io/example/pi:1',
  'display.resume_hint: true',
  'display.bell_on_complete: false',
  'logs.rotation.enabled: true',
  'modelCatalog.enabled: true',
];

async function seed(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), `${ORIGINAL.join('\n')}\n`);
  return storage;
}

async function readLines(storage: InMemoryStorage): Promise<string[]> {
  const src = await storage.read(join(ethosDir(), 'config.yaml'));
  if (src === null) throw new Error('config.yaml missing after write');
  return src.split('\n').filter((l) => l.length > 0);
}

describe('writeConfig preserves keys it cannot express', () => {
  it('changing one key leaves every other line intact', async () => {
    const storage = await seed();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(
      storage,
      { ...cfg, personality: 'brand-guide' },
      new InMemorySecretsResolver(),
    );

    const after = await readLines(storage);
    for (const line of ORIGINAL) {
      if (line.startsWith('personality:')) continue;
      expect(after).toContain(line);
    }
    expect(after).toContain('personality: brand-guide');
  });

  it('does not invent keys the file never had', async () => {
    const storage = await seed();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(
      storage,
      { ...cfg, personality: 'brand-guide' },
      new InMemorySecretsResolver(),
    );

    const keys = (await readLines(storage)).map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).not.toContain('apiKey');
    expect(keys.filter((k) => k === 'personality')).toHaveLength(1);
  });

  it('still deletes a key the caller explicitly cleared', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: m',
        'personality: default',
        'skin: mono',
      ].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, { ...cfg, skin: undefined }, new InMemorySecretsResolver());

    const after = await readLines(storage);
    expect(after.some((l) => l.startsWith('skin:'))).toBe(false);
  });
});

describe('writeConfig over an unparseable file', () => {
  it('writes the fresh config instead of throwing', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    // `backup.keep: 0` is one of the values parseConfigYaml rejects outright.
    await storage.write(join(ethosDir(), 'config.yaml'), 'backup.keep: 0\n');

    await writeConfig(
      storage,
      { provider: 'anthropic', model: 'm', apiKey: '', personality: 'default' },
      new InMemorySecretsResolver(),
    );

    expect(await readLines(storage)).toContain('personality: default');
  });
});
