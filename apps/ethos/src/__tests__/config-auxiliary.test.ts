import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readConfig, writeConfig } from '../config';

// context_compression F1 — auxiliary.compression config block.
describe('auxiliary.compression config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('parses a model-only auxiliary.compression block', async () => {
    const cfg = await load(
      [...base, 'auxiliary.compression.model: claude-haiku-4-5-20251001'].join('\n'),
    );
    expect(cfg?.auxiliary?.compression).toEqual({ model: 'claude-haiku-4-5-20251001' });
  });

  it('parses provider / apiKey / baseUrl overrides', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.compression.model: gpt-5-mini',
        'auxiliary.compression.provider: openrouter',
        'auxiliary.compression.apiKey: sk-or-aux',
        'auxiliary.compression.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.compression).toEqual({
      model: 'gpt-5-mini',
      provider: 'openrouter',
      apiKey: 'sk-or-aux',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('leaves auxiliary undefined when no model is configured', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.auxiliary).toBeUndefined();
  });

  it('round-trips auxiliary.compression through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      auxiliary: {
        compression: {
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'sk-aux',
        },
      },
    };
    await writeConfig(storage, original);
    const roundTripped = await readConfig(storage);
    expect(roundTripped?.auxiliary?.compression).toEqual(original.auxiliary.compression);
  });
});

// tools-vision P2 — auxiliary.vision config block. Mirrors the compression
// shape exactly: a cheap model/provider override the vision_analyze tool
// routes its LLM call through (so a non-vision-capable primary personality
// can still use vision).
describe('auxiliary.vision config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('parses a model-only auxiliary.vision block', async () => {
    const cfg = await load([...base, 'auxiliary.vision.model: claude-sonnet-4-6'].join('\n'));
    expect(cfg?.auxiliary?.vision).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('parses provider / apiKey / baseUrl overrides', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.vision.model: gpt-5-mini',
        'auxiliary.vision.provider: openrouter',
        'auxiliary.vision.apiKey: sk-or-vision',
        'auxiliary.vision.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.vision).toEqual({
      model: 'gpt-5-mini',
      provider: 'openrouter',
      apiKey: 'sk-or-vision',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('leaves auxiliary.vision undefined when no model is configured', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.auxiliary?.vision).toBeUndefined();
  });

  it('round-trips auxiliary.vision through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      auxiliary: {
        vision: {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          apiKey: 'sk-vision',
        },
      },
    };
    await writeConfig(storage, original);
    const roundTripped = await readConfig(storage);
    expect(roundTripped?.auxiliary?.vision).toEqual(original.auxiliary.vision);
  });

  it('parses both auxiliary.compression and auxiliary.vision together', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.compression.model: claude-haiku-4-5-20251001',
        'auxiliary.vision.model: claude-sonnet-4-6',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.compression).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(cfg?.auxiliary?.vision).toEqual({ model: 'claude-sonnet-4-6' });
  });
});
