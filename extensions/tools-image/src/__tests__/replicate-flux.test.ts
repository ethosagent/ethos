import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplicateFluxProvider } from '../providers/replicate-flux';

describe('ReplicateFluxProvider', () => {
  const provider = new ReplicateFluxProvider();
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = 'test-token';
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    delete process.env.REPLICATE_API_TOKEN;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — immediate success
  // -------------------------------------------------------------------------

  it('returns buffer, cost_usd, and prompt_used (echoed original) on immediate success', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    // POST /predictions — immediate success
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-1',
        status: 'succeeded',
        output: ['https://replicate.delivery/image.png'],
      }),
    });

    // GET image download
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => imageBytes.buffer,
    });

    const result = await provider.generate({
      prompt: 'a sunset',
      size: '1024x1024',
      quality: 'standard',
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.cost_usd).toBe(0.003);
    expect(result.prompt_used).toBe('a sunset');
  });

  // -------------------------------------------------------------------------
  // Polling path
  // -------------------------------------------------------------------------

  it('polls until succeeded and returns result', async () => {
    // POST — processing
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-2',
        status: 'processing',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-2' },
      }),
    });

    // First poll — still processing
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-2',
        status: 'processing',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-2' },
      }),
    });

    // Second poll — succeeded
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-2',
        status: 'succeeded',
        output: ['https://replicate.delivery/result.png'],
      }),
    });

    // Image download
    const imageBytes = new Uint8Array([0x89, 0x50]);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => imageBytes.buffer,
    });

    const result = await provider.generate({
      prompt: 'polling test',
      size: '1024x1024',
      quality: 'standard',
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.prompt_used).toBe('polling test');
    // 4 fetch calls: POST + 2 polls + image download
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Prediction failure
  // -------------------------------------------------------------------------

  it('throws when prediction status is failed', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-3',
        status: 'failed',
        error: 'NSFW content detected',
      }),
    });

    await expect(
      provider.generate({ prompt: 'bad', size: '1024x1024', quality: 'standard' }),
    ).rejects.toThrow('NSFW content detected');
  });

  // -------------------------------------------------------------------------
  // API error (non-ok response)
  // -------------------------------------------------------------------------

  it('throws on initial API error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limit exceeded',
    });

    await expect(
      provider.generate({ prompt: 'test', size: '1024x1024', quality: 'standard' }),
    ).rejects.toThrow('429');
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  it('throws on timeout when poll never succeeds', async () => {
    // POST — processing
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-4',
        status: 'processing',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-4' },
      }),
    });

    // Every poll returns processing — will timeout
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'pred-4',
        status: 'processing',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-4' },
      }),
    });

    // Use a very short timeout to make test fast
    // We need to override the timeout — the provider uses POLL_TIMEOUT_MS = 120_000
    // We'll test that the timeout mechanism works by mocking Date.now
    const realDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call sets deadline, subsequent calls exceed it
      if (callCount <= 1) return 1000;
      return 200_000; // well past the 120s timeout
    });

    await expect(
      provider.generate({ prompt: 'timeout', size: '1024x1024', quality: 'standard' }),
    ).rejects.toThrow('timed out');

    Date.now = realDateNow;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // onProgress callback during polling
  // -------------------------------------------------------------------------

  it('calls onProgress during polling', async () => {
    const onProgress = vi.fn();

    // POST — processing
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-5',
        status: 'processing',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-5' },
      }),
    });

    // First poll — succeeded
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'pred-5',
        status: 'succeeded',
        output: ['https://replicate.delivery/done.png'],
      }),
    });

    // Image download
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    });

    const result = await provider.generate({
      prompt: 'progress test',
      size: '1024x1024',
      quality: 'standard',
      onProgress,
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(onProgress).toHaveBeenCalled();
    // The message should contain something about polling
    const firstCall = onProgress.mock.calls[0][0] as string;
    expect(firstCall).toMatch(/polling|generat/i);
  });
});
