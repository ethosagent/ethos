import { join } from 'node:path';
import { readLockfile } from '@ethosagent/plugin-loader';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { updatePersonalityPluginConfig } from '../plugin';

describe('plugin install --personality write-back', () => {
  it('writes lockfile entry for new plugin', async () => {
    const storage = new InMemoryStorage();
    const personalityDir = '/personalities/demo';
    await storage.mkdir(personalityDir);
    await storage.write(join(personalityDir, 'config.yaml'), 'name: demo\n');

    await updatePersonalityPluginConfig(storage, personalityDir, 'tools-zerodha', {
      package: '@ethos-plugins/tools-zerodha',
      version: '1.4.2',
      registry: 'https://registry.npmjs.org',
      integrity: 'sha512-abc123',
    });

    const lockfile = await readLockfile(storage, personalityDir);
    expect(lockfile['tools-zerodha']).toEqual({
      package: '@ethos-plugins/tools-zerodha',
      version: '1.4.2',
      registry: 'https://registry.npmjs.org',
      integrity: 'sha512-abc123',
    });
  });

  it('adds plugin id to config.yaml plugins list', async () => {
    const storage = new InMemoryStorage();
    const personalityDir = '/personalities/demo';
    await storage.mkdir(personalityDir);
    await storage.write(join(personalityDir, 'config.yaml'), 'name: demo\n');

    await updatePersonalityPluginConfig(storage, personalityDir, 'tools-zerodha', {
      package: '@ethos-plugins/tools-zerodha',
      version: '1.4.2',
      registry: 'https://registry.npmjs.org',
      integrity: 'sha512-abc123',
    });

    const config = await storage.read(join(personalityDir, 'config.yaml'));
    expect(config).toContain('plugins:');
    expect(config).toContain('tools-zerodha');
  });

  it('appends to existing plugins list without duplicating', async () => {
    const storage = new InMemoryStorage();
    const personalityDir = '/personalities/demo';
    await storage.mkdir(personalityDir);
    await storage.write(
      join(personalityDir, 'config.yaml'),
      'name: demo\nplugins: existing-plugin\n',
    );

    await updatePersonalityPluginConfig(storage, personalityDir, 'tools-zerodha', {
      package: '@ethos-plugins/tools-zerodha',
      version: '1.4.2',
      registry: 'https://registry.npmjs.org',
      integrity: 'sha512-abc123',
    });

    const config = await storage.read(join(personalityDir, 'config.yaml'));
    expect(config).toContain('plugins: existing-plugin tools-zerodha');
  });

  it('does not duplicate plugin id in config.yaml', async () => {
    const storage = new InMemoryStorage();
    const personalityDir = '/personalities/demo';
    await storage.mkdir(personalityDir);
    await storage.write(
      join(personalityDir, 'config.yaml'),
      'name: demo\nplugins: tools-zerodha\n',
    );

    await updatePersonalityPluginConfig(storage, personalityDir, 'tools-zerodha', {
      package: '@ethos-plugins/tools-zerodha',
      version: '1.4.2',
      registry: 'https://registry.npmjs.org',
      integrity: 'sha512-abc123',
    });

    const config = await storage.read(join(personalityDir, 'config.yaml'));
    const pluginsLine = config?.split('\n').find((l) => l.startsWith('plugins:'));
    const ids = pluginsLine?.replace('plugins:', '').trim().split(/\s+/) ?? [];
    expect(ids.filter((id) => id === 'tools-zerodha')).toHaveLength(1);
  });
});
