// The `allowUnattendedDangerousTools` operator key — lets a personality's
// `approvalMode: off` auto-approve flagged tools on the gateway systemLoop,
// where no human is present to answer an approval prompt. A safety opt-in, so
// only the literal `true` enables it.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

describe('allowUnattendedDangerousTools config key', () => {
  it('parses true', async () => {
    const cfg = await load([...base, 'allowUnattendedDangerousTools: true'].join('\n'));
    expect(cfg?.allowUnattendedDangerousTools).toBe(true);
  });

  it('is absent when not set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.allowUnattendedDangerousTools).toBeUndefined();
  });

  it('stays off for false and for anything that is not the literal true', async () => {
    for (const value of ['false', 'yes', '1', 'TRUE', '']) {
      const cfg = await load([...base, `allowUnattendedDangerousTools: ${value}`].join('\n'));
      expect(cfg?.allowUnattendedDangerousTools).toBeUndefined();
    }
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        allowUnattendedDangerousTools: true,
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.allowUnattendedDangerousTools).toBe(true);
  });

  it('writeConfig omits the key when unset', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'llama3.2', apiKey: 'sk', personality: 'p' },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('allowUnattendedDangerousTools');
  });
});
