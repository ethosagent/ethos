import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the openai SDK before importing the provider
// ---------------------------------------------------------------------------

const mockGenerate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class OpenAI {
      images = { generate: mockGenerate };
    },
  };
});

import { OpenAIDalleProvider } from '../providers/openai-dalle';

describe('OpenAIDalleProvider', () => {
  const provider = new OpenAIDalleProvider();

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockGenerate.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // -------------------------------------------------------------------------
  // supports()
  // -------------------------------------------------------------------------

  describe('supports()', () => {
    it('returns true for 1024x1024 standard', () => {
      expect(provider.supports('1024x1024', 'standard')).toBe(true);
    });

    it('returns false for 512x512 hd', () => {
      expect(provider.supports('512x512', 'hd')).toBe(false);
    });

    it('returns false for unsupported size', () => {
      expect(provider.supports('256x256', 'standard')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // generate() — happy path
  // -------------------------------------------------------------------------

  describe('generate() happy path', () => {
    it('returns buffer, cost_usd, and prompt_used from revised_prompt', async () => {
      const fakeB64 = Buffer.from('fake-image-data').toString('base64');
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: fakeB64, revised_prompt: 'A beautiful cat in a garden' }],
      });

      const result = await provider.generate({
        prompt: 'a cat',
        size: '1024x1024',
        quality: 'standard',
      });

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.cost_usd).toBe(0.04);
      expect(result.prompt_used).toBe('A beautiful cat in a garden');
    });

    it('falls back to original prompt when revised_prompt is absent', async () => {
      const fakeB64 = Buffer.from('fake-image-data').toString('base64');
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: fakeB64 }],
      });

      const result = await provider.generate({
        prompt: 'a cat',
        size: '1024x1024',
        quality: 'standard',
      });

      expect(result.prompt_used).toBe('a cat');
    });

    it('returns correct cost for 1024x1792 hd', async () => {
      const fakeB64 = Buffer.from('fake').toString('base64');
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: fakeB64, revised_prompt: 'test' }],
      });

      const result = await provider.generate({
        prompt: 'test',
        size: '1024x1792',
        quality: 'hd',
      });

      expect(result.cost_usd).toBe(0.12);
    });
  });

  // -------------------------------------------------------------------------
  // generate() — error paths
  // -------------------------------------------------------------------------

  describe('generate() errors', () => {
    it('throws on content policy rejection', async () => {
      mockGenerate.mockRejectedValue(new Error('content policy violation'));
      await expect(
        provider.generate({ prompt: 'bad', size: '1024x1024', quality: 'standard' }),
      ).rejects.toThrow('content policy');
    });

    it('throws on rate limit', async () => {
      mockGenerate.mockRejectedValue(new Error('rate limit exceeded (429)'));
      await expect(
        provider.generate({ prompt: 'test', size: '1024x1024', quality: 'standard' }),
      ).rejects.toThrow('rate limit');
    });

    it('throws on server error', async () => {
      mockGenerate.mockRejectedValue(new Error('server error 500'));
      await expect(
        provider.generate({ prompt: 'test', size: '1024x1024', quality: 'standard' }),
      ).rejects.toThrow('server error');
    });

    it('throws when no image data returned', async () => {
      mockGenerate.mockResolvedValue({ data: [{}] });
      await expect(
        provider.generate({ prompt: 'test', size: '1024x1024', quality: 'standard' }),
      ).rejects.toThrow('no image data');
    });
  });
});
