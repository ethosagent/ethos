import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// Plan openclaw-9.5-adoption item 3 (D7/D22) — flat `memoryCapture.evidenceSessions`.
describe('memoryCapture.evidenceSessions config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    'apiKey: sk',
    'personality: p',
    'memoryCapture.enabled: true',
  ];

  it('is absent when the key is missing (default off)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.memoryCapture).toEqual({ enabled: true });
    expect(cfg?.memoryCapture?.evidenceSessions).toBeUndefined();
  });

  it('parses 0', async () => {
    const cfg = await load([...base, 'memoryCapture.evidenceSessions: 0'].join('\n'));
    expect(cfg?.memoryCapture?.evidenceSessions).toBe(0);
  });

  it('parses 3', async () => {
    const cfg = await load([...base, 'memoryCapture.evidenceSessions: 3'].join('\n'));
    expect(cfg?.memoryCapture?.evidenceSessions).toBe(3);
  });

  it.each(['-1', '2.5', 'three', '3x', '17'])('refuses %s, naming the key', async (value) => {
    await expect(
      load([...base, `memoryCapture.evidenceSessions: ${value}`].join('\n')),
    ).rejects.toThrow(/Invalid memoryCapture\.evidenceSessions/);
  });

  it('round-trips through writeConfig + parse', async () => {
    const storage = new InMemoryStorage();
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'p',
      memoryCapture: { enabled: true, evidenceSessions: 3 },
    };
    await writeConfig(storage, config, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('memoryCapture.evidenceSessions: 3');
    const reparsed = await readRawConfig(storage);
    expect(reparsed?.memoryCapture).toEqual({ enabled: true, evidenceSessions: 3 });
  });
});
