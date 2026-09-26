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

// B5 (plan ux-feedback-and-config-clarity §6.6): comments and blank lines
// survive a rewrite, attached BY KEY, never by position.
describe('writeConfig preserves comments (B5)', () => {
  const COMMENTED = [
    '# ethos config — hand-tuned',
    '# do not deploy on fridays',
    'schemaVersion: 1',
    'provider: anthropic',
    'model: claude-opus-4-7',
    '',
    '# who answers by default',
    'personality: default',
    'display.bell_on_complete: false',
    '',
    '# ---- terminal niceties ----',
    'skin: mono',
    '# trailing note kept at the end',
  ];

  async function seedCommented(): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), `${COMMENTED.join('\n')}\n`);
    return storage;
  }

  async function readRaw(storage: InMemoryStorage): Promise<string> {
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    if (src === null) throw new Error('config.yaml missing after write');
    return src;
  }

  it('a comment above a key survives a value change, above the same key', async () => {
    const storage = await seedCommented();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, { ...cfg, personality: 'engineer' }, new InMemorySecretsResolver());

    const after = await readRaw(storage);
    const lines = after.split('\n');
    // Leading file comments stay at the top.
    expect(lines[0]).toBe('# ethos config — hand-tuned');
    expect(lines[1]).toBe('# do not deploy on fridays');
    // The block (blank line + comment) still sits immediately above its key.
    const idx = lines.indexOf('personality: engineer');
    expect(idx).toBeGreaterThan(0);
    expect(lines[idx - 1]).toBe('# who answers by default');
    expect(lines[idx - 2]).toBe('');
    // The section heading follows its key even though the serializer emits
    // `skin` at a different position than the original file had it.
    const sIdx = lines.indexOf('skin: mono');
    expect(lines[sIdx - 1]).toBe('# ---- terminal niceties ----');
    // The trailing comment stays at the end.
    expect(after.trimEnd().endsWith('# trailing note kept at the end')).toBe(true);
  });

  it('comments above a deleted key are kept under the unattached tail', async () => {
    const storage = await seedCommented();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, { ...cfg, skin: undefined }, new InMemorySecretsResolver());

    const after = await readRaw(storage);
    expect(after).not.toContain('skin: mono');
    expect(after).toContain('# --- unattached ---');
    expect(after).toContain('# ---- terminal niceties ----');
    const lines = after.split('\n');
    expect(lines.indexOf('# ---- terminal niceties ----')).toBeGreaterThan(
      lines.indexOf('# --- unattached ---'),
    );
  });

  it('a double write is byte-identical', async () => {
    const storage = await seedCommented();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(storage, { ...cfg, personality: 'engineer' }, new InMemorySecretsResolver());
    const first = await readRaw(storage);

    const cfg2 = await readRawConfig(storage);
    if (!cfg2) throw new Error('rewritten config did not parse');
    await writeConfig(storage, cfg2, new InMemorySecretsResolver());
    const second = await readRaw(storage);

    expect(second).toBe(first);
  });

  it('a double write with an unattached tail is byte-identical too', async () => {
    const storage = await seedCommented();
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');
    await writeConfig(storage, { ...cfg, skin: undefined }, new InMemorySecretsResolver());
    const first = await readRaw(storage);
    expect(first).toContain('# --- unattached ---');

    const cfg2 = await readRawConfig(storage);
    if (!cfg2) throw new Error('rewritten config did not parse');
    await writeConfig(storage, cfg2, new InMemorySecretsResolver());
    const second = await readRaw(storage);

    expect(second).toBe(first);
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
