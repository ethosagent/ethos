import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig } from '../config';

// plugins.auto_install — controls whether personality lockfile plugins
// are auto-installed on load.

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — plugins.auto_install', () => {
  it('pluginsAutoInstall is undefined when plugins.auto_install is not in config', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
      ].join('\n'),
    );
    expect(cfg.pluginsAutoInstall).toBeUndefined();
  });

  it('parses plugins.auto_install: true → pluginsAutoInstall === true', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'plugins.auto_install: true',
      ].join('\n'),
    );
    expect(cfg.pluginsAutoInstall).toBe(true);
  });

  it('parses plugins.auto_install: false → pluginsAutoInstall === false', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'plugins.auto_install: false',
      ].join('\n'),
    );
    expect(cfg.pluginsAutoInstall).toBe(false);
  });
});
