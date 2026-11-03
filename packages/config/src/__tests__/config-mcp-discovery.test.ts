// `mcp.discoveryConcurrency` (plan hermes-0.22-hardening §5.2 item 4, D15):
// an integer 1-16, written back verbatim, anything else warns and stays unset.

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

const WARNING = 'mcp.discoveryConcurrency must be an integer from 1 to 16; using the default (4)';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return { storage, config: await readRawConfig(storage) };
}

describe('mcp.discoveryConcurrency config parsing', () => {
  it('parses and round-trips mcp.discoveryConcurrency', async () => {
    const { storage, config } = await load([...base, 'mcp.discoveryConcurrency: 8'].join('\n'));
    expect(config?.mcp).toEqual({ discoveryConcurrency: 8 });
    expect(
      configParseNotices(parseConfigYaml([...base, 'mcp.discoveryConcurrency: 8'].join('\n')))
        .warnings,
    ).toEqual([]);

    if (!config) throw new Error('config did not load');
    await writeConfig(storage, config, new InMemorySecretsResolver());
    const written = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(written).toContain('mcp.discoveryConcurrency: 8');
    expect((await readRawConfig(storage))?.mcp).toEqual({ discoveryConcurrency: 8 });
  });

  it('accepts the bounds 1 and 16', async () => {
    expect((await load([...base, 'mcp.discoveryConcurrency: 1'].join('\n'))).config?.mcp).toEqual({
      discoveryConcurrency: 1,
    });
    expect((await load([...base, 'mcp.discoveryConcurrency: 16'].join('\n'))).config?.mcp).toEqual({
      discoveryConcurrency: 16,
    });
  });

  it('out-of-range or non-integer values warn and stay unset', async () => {
    for (const bad of ['0', '17', '-2', '2.5', 'many']) {
      const yaml = [...base, `mcp.discoveryConcurrency: ${bad}`].join('\n');
      expect((await load(yaml)).config?.mcp, bad).toBeUndefined();
      expect(configParseNotices(parseConfigYaml(yaml)).warnings, bad).toContain(WARNING);
    }
  });

  it('mcp.unknownKey gets the has-no-effect notice, not unknown key', () => {
    const notices = configParseNotices(
      parseConfigYaml([...base, 'mcp.unknownKey: 3'].join('\n')),
    ).warnings.join('\n');
    expect(notices).not.toContain('unknown key');
    expect(notices).toContain("'mcp.unknownKey' has no effect");
  });
});
