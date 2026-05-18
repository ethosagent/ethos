import { describe, expect, it, vi } from 'vitest';

describe('emitReady', () => {
  it('emits structured ready signal via stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { emitReady } = await import('../logger');
    emitReady('gateway');

    expect(writeSpy).toHaveBeenCalledOnce();
    const raw = writeSpy.mock.calls[0]?.[0] as string;
    expect(typeof raw).toBe('string');
    const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(obj.event).toBe('ethos.ready');
    expect(obj.command).toBe('gateway');
    expect(typeof obj.version).toBe('string');
    expect(obj.pid).toBe(process.pid);
    expect(typeof obj.timestamp).toBe('string');
    // timestamp is a valid ISO 8601 date
    expect(() => new Date(obj.timestamp as string).toISOString()).not.toThrow();

    writeSpy.mockRestore();
  });

  it('uses the command argument verbatim', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { emitReady } = await import('../logger');
    emitReady('serve');

    const raw = writeSpy.mock.calls[0]?.[0] as string;
    const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(obj.command).toBe('serve');

    writeSpy.mockRestore();
  });
});
