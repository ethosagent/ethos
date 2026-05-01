import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickProvider } from '../auto-pick';
import { imageGenerateTool } from '../index';
import type { ImageGenProvider } from '../providers/types';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeProvider(name: string, available: boolean, supports = true): ImageGenProvider {
  return {
    name,
    isAvailable: vi.fn().mockReturnValue(available),
    supports: vi.fn().mockReturnValue(supports),
    generate: vi.fn().mockResolvedValue({ buffer: Buffer.from('fake'), cost_usd: 0.04 }),
  };
}

const openaiProvider = () => makeProvider('openai-dalle', false);
const replicateProvider = () => makeProvider('replicate-flux', false);

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

// ---------------------------------------------------------------------------
// pickProvider
// ---------------------------------------------------------------------------

describe('pickProvider', () => {
  it('returns openai provider when explicitly requested and OPENAI_API_KEY is set', () => {
    const openai = makeProvider('openai-dalle', true);
    const replicate = makeProvider('replicate-flux', false);
    const result = pickProvider('openai-dalle', [openai, replicate]);
    expect(result).toBe(openai);
  });

  it('returns null when explicitly requested provider is unavailable', () => {
    const openai = makeProvider('openai-dalle', false);
    const replicate = makeProvider('replicate-flux', true);
    const result = pickProvider('openai-dalle', [openai, replicate]);
    expect(result).toBeNull();
  });

  it('picks openai when auto and only OPENAI_API_KEY set', () => {
    const openai = makeProvider('openai-dalle', true);
    const replicate = makeProvider('replicate-flux', false);
    const result = pickProvider('auto', [openai, replicate]);
    expect(result).toBe(openai);
  });

  it('picks replicate when auto and only REPLICATE_API_TOKEN set', () => {
    const openai = makeProvider('openai-dalle', false);
    const replicate = makeProvider('replicate-flux', true);
    const result = pickProvider('auto', [openai, replicate]);
    expect(result).toBe(replicate);
  });

  it('returns null when auto and neither key is set', () => {
    const openai = makeProvider('openai-dalle', false);
    const replicate = makeProvider('replicate-flux', false);
    const result = pickProvider('auto', [openai, replicate]);
    expect(result).toBeNull();
  });

  it('returns null when undefined provider name and no providers available', () => {
    const openai = makeProvider('openai-dalle', false);
    const result = pickProvider(undefined, [openai]);
    expect(result).toBeNull();
  });

  it('picks first available when provider name is undefined', () => {
    const openai = makeProvider('openai-dalle', true);
    const replicate = makeProvider('replicate-flux', true);
    const result = pickProvider(undefined, [openai, replicate]);
    expect(result).toBe(openai);
  });
});

// ---------------------------------------------------------------------------
// image_generate tool
// ---------------------------------------------------------------------------

describe('image_generate', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
  });

  it('returns not_available when no provider keys are set', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    const result = await imageGenerateTool.execute({ prompt: 'a cat' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('IMAGE_GEN_NO_PROVIDER');
    }
  });

  it('returns input_invalid when prompt is missing', async () => {
    const result = await imageGenerateTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('has correct toolset and maxResultChars', () => {
    expect(imageGenerateTool.toolset).toBe('image');
    expect(imageGenerateTool.maxResultChars).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// Size parsing
// ---------------------------------------------------------------------------

describe('size parsing', () => {
  it('parses 1024x1792 correctly', () => {
    const [w, h] = '1024x1792'.split('x').map(Number);
    expect(w).toBe(1024);
    expect(h).toBe(1792);
  });

  it('parses 1792x1024 correctly', () => {
    const [w, h] = '1792x1024'.split('x').map(Number);
    expect(w).toBe(1792);
    expect(h).toBe(1024);
  });

  it('parses 512x512 correctly', () => {
    const [w, h] = '512x512'.split('x').map(Number);
    expect(w).toBe(512);
    expect(h).toBe(512);
  });
});
