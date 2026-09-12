import { describe, expect, it, vi } from 'vitest';
import { createAndBindCredential } from '../create-and-bind-credential';

// Cases 20–21 — create-and-bind writes vault then binding; save-globally uses
// the same sequence with scope: 'global' (caller supplies the _default bind).

describe('createAndBindCredential', () => {
  it('creates the vault secret before writing the personality binding (case 20)', async () => {
    const order: string[] = [];
    const create = vi.fn(async (input: { provider: string; name: string; value: string }) => {
      order.push('create');
      expect(input).toEqual({ provider: 'xai', name: 'seoMain', value: 'sk-test' });
    });
    const bind = vi.fn(async (values: Record<string, Record<string, string>>) => {
      order.push('bind');
      expect(values).toEqual({ x_search: { secret: 'seoMain' } });
    });

    await createAndBindCredential({
      create,
      bind,
      provider: 'xai',
      name: 'seoMain',
      value: 'sk-test',
      key: 'x_search',
      scope: 'personality',
    });

    expect(order).toEqual(['create', 'bind']);
    expect(create).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledOnce();
  });

  it('leaves the vault value when bind fails (case 20)', async () => {
    const create = vi.fn(async () => undefined);
    const bind = vi.fn(async () => {
      throw new Error('bind refused');
    });

    await expect(
      createAndBindCredential({
        create,
        bind,
        provider: 'xai',
        name: 'seoMain',
        value: 'sk-test',
        key: 'x_search',
        scope: 'personality',
      }),
    ).rejects.toThrow('bind refused');

    expect(create).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledOnce();
  });

  it('writes _default via the global bind with scope global (case 21)', async () => {
    const create = vi.fn(async () => undefined);
    const bind = vi.fn(async (values: Record<string, Record<string, string>>) => {
      expect(values).toEqual({
        web_search: { provider: 'exa', secret: 'globalExa' },
      });
    });

    await createAndBindCredential({
      create,
      bind,
      provider: 'exa',
      name: 'globalExa',
      value: 'sk-exa',
      key: 'web_search',
      scope: 'global',
      bindingExtra: { provider: 'exa' },
    });

    expect(create).toHaveBeenCalledWith({
      provider: 'exa',
      name: 'globalExa',
      value: 'sk-exa',
    });
    expect(bind).toHaveBeenCalledOnce();
  });
});
