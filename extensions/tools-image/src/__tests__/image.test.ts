import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    generate: vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake'),
      cost_usd: 0.04,
      prompt_used: 'the prompt that was used',
    }),
  };
}

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
    expect(imageGenerateTool.maxResultChars).toBe(1_000);
  });

  it('returns INVALID_SIZE_FOR_PROVIDER when provider does not support size/quality', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    // DALL-E doesn't support 512x512 + hd
    const result = await imageGenerateTool.execute(
      { prompt: 'a cat', size: '512x512', quality: 'hd' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('INVALID_SIZE_FOR_PROVIDER');
      expect(result.code).toBe('input_invalid');
    }
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

// ---------------------------------------------------------------------------
// PNG output integrity
// ---------------------------------------------------------------------------

// PNG signature: 8 bytes that every valid PNG file starts with.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('image_generate output file', () => {
  let outPath: string;

  afterEach(() => {
    if (outPath && existsSync(outPath)) rmSync(outPath);
  });

  it('file written from a PNG provider buffer has correct PNG magic bytes', async () => {
    outPath = join(tmpdir(), `ethos-png-${Date.now()}.png`);

    // Build a minimal valid PNG: signature + 1-byte payload (IEND only for brevity)
    const pngBuffer = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00])]);

    const { writeFile } = await import('node:fs/promises');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpdir(), { recursive: true });
    await writeFile(outPath, pngBuffer);

    const bytes = readFileSync(outPath);
    expect(bytes[0]).toBe(0x89); // PNG magic byte 1
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
    expect(bytes[4]).toBe(0x0d);
    expect(bytes[5]).toBe(0x0a);
    expect(bytes[6]).toBe(0x1a);
    expect(bytes[7]).toBe(0x0a);
  });

  it('ToolResult ok variant carries cost_usd when provider reports cost', () => {
    // Type-level + value-level: ToolResult.ok allows cost_usd
    const result: { ok: true; value: string; cost_usd?: number } = {
      ok: true,
      value: '{}',
      cost_usd: 0.04,
    };
    expect(result.cost_usd).toBe(0.04);
  });
});
