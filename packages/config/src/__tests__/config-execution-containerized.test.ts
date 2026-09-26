// `execution.containerized: true` — the operator's statement that this
// deployment is itself the isolation boundary (Ethos runs inside a container
// auto-detection cannot see), read by `detectContainerized`
// (packages/wiring/src/resolve-execution-posture.ts) as its explicit config
// signal. The retired `execution: local` personality value tells operators to
// set it (`RETIRED_EXECUTION_VALUES`, extensions/personalities/src/index.ts),
// so it must parse — and must not be reported as a key with no effect.

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

describe('execution.containerized config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses true', async () => {
    const cfg = await load([...base, 'execution.containerized: true'].join('\n'));
    expect(cfg?.execution).toEqual({ containerized: true });
  });

  it('treats anything but true as unset (auto-detection stays in charge)', async () => {
    for (const value of ['false', 'yes', '1']) {
      const cfg = await load([...base, `execution.containerized: ${value}`].join('\n'));
      expect(cfg?.execution?.containerized).toBeUndefined();
    }
  });

  it('is not reported as an unknown key', () => {
    const notices = configParseNotices(
      parseConfigYaml([...base, 'execution.containerized: true'].join('\n')),
    );
    expect(notices.warnings.filter((w) => w.includes('execution.containerized'))).toEqual([]);
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      execution: { containerized: true },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.execution).toEqual(original.execution);
  });
});
