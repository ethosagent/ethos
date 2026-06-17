import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../config';

// context_compression F1 — auxiliary.compression config block.
describe('auxiliary.compression config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
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
    const roundTripped = await readRawConfig(storage);
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
    return readRawConfig(storage);
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
    const roundTripped = await readRawConfig(storage);
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

describe('writeConfig round-trip — previously dropped fields', () => {
  it('round-trips email, display, evolver, background, and providers fields', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-test',
      personality: 'researcher',
      emailImapHost: 'imap.example.com',
      emailImapPort: 993,
      emailUser: 'user@example.com',
      emailPassword: 'secret',
      emailSmtpHost: 'smtp.example.com',
      emailSmtpPort: 587,
      displayResumeHint: false,
      displayResumeRecapTurns: 5,
      displayBellOnComplete: true,
      evolverCronEnabled: true,
      evolverSchedule: '0 3 * * *',
      backgroundMaxConcurrent: 8,
      providers: [
        { provider: 'anthropic', apiKey: 'sk-ant-1', model: 'claude-opus-4-7' },
        { provider: 'openrouter', apiKey: 'sk-or-2', baseUrl: 'https://openrouter.ai/api/v1' },
      ],
    };
    await writeConfig(storage, original);
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.emailImapHost).toBe('imap.example.com');
    expect(roundTripped?.emailImapPort).toBe(993);
    expect(roundTripped?.emailUser).toBe('user@example.com');
    expect(roundTripped?.emailPassword).toBe('secret');
    expect(roundTripped?.emailSmtpHost).toBe('smtp.example.com');
    expect(roundTripped?.emailSmtpPort).toBe(587);
    expect(roundTripped?.displayResumeHint).toBe(false);
    expect(roundTripped?.displayResumeRecapTurns).toBe(5);
    expect(roundTripped?.displayBellOnComplete).toBe(true);
    expect(roundTripped?.evolverCronEnabled).toBe(true);
    expect(roundTripped?.evolverSchedule).toBe('0 3 * * *');
    expect(roundTripped?.backgroundMaxConcurrent).toBe(8);
    expect(roundTripped?.providers).toHaveLength(2);
    expect(roundTripped?.providers?.[0]).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-1',
      model: 'claude-opus-4-7',
    });
    expect(roundTripped?.providers?.[1]).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-or-2',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });
});

// Phase 3c E — nightlyPass scheduler config block.
describe('nightlyPass config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('is undefined when absent (default-off)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.nightlyPass).toBeUndefined();
  });

  it('parses enabled and cron', async () => {
    const cfg = await load(
      [...base, 'nightlyPass.enabled: true', 'nightlyPass.cron: 0 4 * * *'].join('\n'),
    );
    expect(cfg?.nightlyPass).toEqual({ enabled: true, cron: '0 4 * * *' });
  });

  it('parses enabled: false', async () => {
    const cfg = await load([...base, 'nightlyPass.enabled: false'].join('\n'));
    expect(cfg?.nightlyPass).toEqual({ enabled: false });
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-test',
      personality: 'researcher',
      nightlyPass: { enabled: true, cron: '0 3 * * *' },
    });
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.nightlyPass).toEqual({ enabled: true, cron: '0 3 * * *' });
  });
});
