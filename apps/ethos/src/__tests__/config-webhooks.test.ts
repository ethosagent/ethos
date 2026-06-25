import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  writeConfig,
} from '../config';

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

async function loadStrict(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return loadConfigStrict(storage);
}

const base = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

describe('parseConfigYaml — webhooks', () => {
  it('parses a webhooks block with personalityId, secret, and sessionKey', async () => {
    const cfg = await load(
      [
        ...base,
        'webhooks.hook1.personalityId: researcher',
        'webhooks.hook1.secret: s3cret',
        'webhooks.hook1.sessionKey: stable-key',
      ].join('\n'),
    );
    expect(cfg.webhooks).toEqual({
      hook1: { personalityId: 'researcher', secret: 's3cret', sessionKey: 'stable-key' },
    });
  });

  it('omits sessionKey when not supplied', async () => {
    const cfg = await load(
      [...base, 'webhooks.h.personalityId: researcher', 'webhooks.h.secret: x'].join('\n'),
    );
    expect(cfg.webhooks?.h).toEqual({ personalityId: 'researcher', secret: 'x' });
  });

  it('leaves webhooks undefined when no block is present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg.webhooks).toBeUndefined();
  });

  it('reports a missing secret as a parseError', async () => {
    const result = await loadStrict(
      [...base, 'webhooks.broken.personalityId: researcher'].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'secret'"))).toBe(
      true,
    );
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('round-trips through writeConfig → readRawConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      webhooks: {
        hook1: { personalityId: 'researcher', secret: 's3cret', sessionKey: 'stable-key' },
        hook2: { personalityId: 'coder', secret: 'abc' },
      },
    };
    await writeConfig(storage, original);
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.webhooks).toEqual(original.webhooks);
  });
});
