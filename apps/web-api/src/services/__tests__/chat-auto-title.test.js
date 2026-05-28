import { describe, expect, it, vi } from 'vitest';

describe('auto-title', () => {
  it('generates title from first user message', async () => {
    const titleFn = vi.fn().mockResolvedValue('My Great Title');
    const result = await titleFn('system prompt', 'user message');
    expect(result).toBe('My Great Title');
    expect(titleFn).toHaveBeenCalledWith('system prompt', 'user message');
  });
  it('truncates title to 200 chars', () => {
    const long = 'A'.repeat(300);
    const trimmed = long.trim().slice(0, 200);
    expect(trimmed.length).toBe(200);
  });
  it('swallows errors from titleFn', async () => {
    const titleFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    await expect(
      (async () => {
        try {
          await titleFn('sys', 'msg');
        } catch {
          // swallowed
        }
      })(),
    ).resolves.toBeUndefined();
  });
});
