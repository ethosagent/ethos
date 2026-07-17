import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { platformsRouter } from '../platforms';

// Field-mapping smoke test for the platforms RPC handlers. The validate
// handler is a thin passthrough — this guards against an id/fields swap or a
// rename silently breaking the onboarding token probe.
describe('platforms RPC — validate handler field mapping', () => {
  it('forwards {id, fields} to platforms.validate unchanged', async () => {
    const validate = vi.fn().mockResolvedValue({ status: 'ok', label: '@bot', error: null });
    // Only the `platforms` service is exercised; the rest of the context is
    // unused by this handler.
    const context = { platforms: { validate } } as never;

    const out = await call(
      platformsRouter.validate,
      { id: 'telegram', fields: { token: 'x' } },
      { context },
    );

    expect(validate).toHaveBeenCalledWith('telegram', { token: 'x' });
    expect(out).toEqual({ status: 'ok', label: '@bot', error: null });
  });
});
