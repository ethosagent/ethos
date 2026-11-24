// `nodes.enabled` — the operator switch for laptop tool nodes (plan laptop-tool-node D18).
// Default off: absent means no /node routes and no node_* tools.
// Strict boolean: only a literal `true` / `false` is read, anything else leaves the block unset
// (a typo must never arm the feature, and never silently pretend to disarm it either).

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
  return { storage, config: await readRawConfig(storage) };
}

describe('nodes config block', () => {
  it('nodes.enabled: true parses', async () => {
    expect((await load([...base, 'nodes.enabled: true'].join('\n'))).config?.nodes).toEqual({
      enabled: true,
    });
  });

  it('nodes.enabled: false parses', async () => {
    expect((await load([...base, 'nodes.enabled: false'].join('\n'))).config?.nodes).toEqual({
      enabled: false,
    });
  });

  it('is absent entirely when the block is not set', async () => {
    expect((await load(base.join('\n'))).config?.nodes).toBeUndefined();
  });

  it('a non-boolean value leaves the block unset and does not crash', async () => {
    for (const raw of ['yes', 'TRUE', '1', 'on', '""']) {
      const { config } = await load([...base, `nodes.enabled: ${raw}`].join('\n'));
      expect(config, raw).toBeDefined();
      expect(config?.nodes, raw).toBeUndefined();
    }
  });

  it('round-trips through writeConfig', async () => {
    const { storage, config } = await load([...base, 'nodes.enabled: true'].join('\n'));
    if (!config) throw new Error('config did not load');
    await writeConfig(storage, config, new InMemorySecretsResolver());
    expect((await readRawConfig(storage))?.nodes).toEqual({ enabled: true });
  });

  it('writeConfig omits the block when unset', async () => {
    const { storage, config } = await load(base.join('\n'));
    if (!config) throw new Error('config did not load');
    await writeConfig(storage, config, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('nodes.');
  });

  it('nodes.bogus gets the has-no-effect notice, not unknown key', () => {
    const notices = configParseNotices(
      parseConfigYaml([...base, 'nodes.bogus: 1'].join('\n')),
    ).warnings.join('\n');
    expect(notices).not.toContain('unknown key');
    expect(notices).toContain("'nodes.bogus' has no effect");
  });
});
