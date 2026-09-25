// R10 (openclaw-9.6-gaps) — `cron.defaultMaxRunMs`: wall-clock cap on a cron
// prompt job's turn when the job sets no `maxRunMs` of its own.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  writeConfig,
} from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

describe('cron.defaultMaxRunMs config parsing', () => {
  it('parses a positive integer', async () => {
    const cfg = await load([...base, 'cron.defaultMaxRunMs: 600000'].join('\n'));
    expect(cfg?.cron).toEqual({ defaultMaxRunMs: 600000 });
  });

  it('drops a non-positive or non-numeric value', async () => {
    expect((await load([...base, 'cron.defaultMaxRunMs: 0'].join('\n')))?.cron).toBeUndefined();
    expect((await load([...base, 'cron.defaultMaxRunMs: soon'].join('\n')))?.cron).toBeUndefined();
  });

  it('is a key the parser reads (no unknown-key notice)', () => {
    const notices = configParseNotices(
      parseConfigYaml([...base, 'cron.defaultMaxRunMs: 600000'].join('\n')),
    );
    expect(notices.warnings.join('\n')).not.toContain('cron.defaultMaxRunMs');
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      cron: { defaultMaxRunMs: 900000 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    expect((await readRawConfig(storage))?.cron).toEqual(original.cron);
  });
});
